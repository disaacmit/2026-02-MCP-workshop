#!/usr/bin/env node

//#region prelude
import { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import {
  CallToolResult,
  ElicitResultSchema,
  GetPromptResult,
  isInitializeRequest,
  ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js';
import { InMemoryEventStore } from '@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js';

const NOMINATIM_API_BASE = 'https://nominatim.openstreetmap.org';
const OPEN_METEO_API_BASE = 'https://api.open-meteo.com/v1';
const USER_AGENT = 'weather-mcp-server/1.0';

// Store recent geocoding results for resources
const recentGeocodingResults: Array<{
  query: string;
  results: NominatimResult[];
  timestamp: Date;
}> = [];
//#endregion prelude

//#region helpers
// Nominatim types
interface NominatimResult {
  place_id: number;
  lat: string;
  lon: string;
  display_name: string;
  type: string;
  importance: number;
}

// Open-Meteo types
interface OpenMeteoResponse {
  current_weather: {
    temperature: number;
    windspeed: number;
    winddirection: number;
    weathercode: number;
    time: string;
  };
  latitude: number;
  longitude: number;
  timezone: string;
}

// Helper function for making Nominatim requests
async function geocodeLocation(query: string): Promise<NominatimResult[]> {
  const url = `${NOMINATIM_API_BASE}/search?q=${encodeURIComponent(query)}&format=json&limit=5`;
  const headers = {
    'User-Agent': USER_AGENT,
  };

  try {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const results = (await response.json()) as NominatimResult[];
    
    // Store results for resources
    recentGeocodingResults.push({
      query,
      results,
      timestamp: new Date(),
    });
    
    // Keep only the last 10 queries
    if (recentGeocodingResults.length > 10) {
      recentGeocodingResults.shift();
    }
    
    return results;
  } catch (error) {
    console.error('Error making Nominatim request:', error);
    return [];
  }
}

// Helper function for making Open-Meteo requests
async function getWeather(latitude: number, longitude: number): Promise<OpenMeteoResponse | null> {
  const url = `${OPEN_METEO_API_BASE}/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return (await response.json()) as OpenMeteoResponse;
  } catch (error) {
    console.error('Error making Open-Meteo request:', error);
    return null;
  }
}

// Weather code descriptions from Open-Meteo
function getWeatherDescription(code: number): string {
  const descriptions: Record<number, string> = {
    0: 'Clear sky',
    1: 'Mainly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Foggy',
    48: 'Depositing rime fog',
    51: 'Light drizzle',
    53: 'Moderate drizzle',
    55: 'Dense drizzle',
    61: 'Slight rain',
    63: 'Moderate rain',
    65: 'Heavy rain',
    71: 'Slight snow',
    73: 'Moderate snow',
    75: 'Heavy snow',
    77: 'Snow grains',
    80: 'Slight rain showers',
    81: 'Moderate rain showers',
    82: 'Violent rain showers',
    85: 'Slight snow showers',
    86: 'Heavy snow showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm with slight hail',
    99: 'Thunderstorm with heavy hail',
  };
  return descriptions[code] || 'Unknown';
}
//#endregion helpers

//#region createServer
// Create server instance factory
const getServer = () => {
  const server = new McpServer(
    {
      name: 'weather',
      version: '1.0.0',
    },
    {
      capabilities: { logging: {} },
    }
  );

  //#region registerTools
  // Register geocoding tool
  server.registerTool(
    'geocode',
    {
      title: 'Geocode Location',
      description: 'Convert a location name or address to coordinates using Nominatim',
      inputSchema: z.object({
        location: z.string().describe('Location name or address to geocode'),
      }),
    },
    async ({ location }) => {
      const results = await geocodeLocation(location);

      if (results.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `No results found for location: ${location}`,
          }],
        };
      }

      if (results.length === 1) {
        const result = results[0];
        return {
          content: [{
            type: 'text' as const,
            text: [
              `Found location: ${result.display_name}`,
              `Latitude: ${result.lat}`,
              `Longitude: ${result.lon}`,
              `Type: ${result.type}`,
            ].join('\n'),
          }],
        };
      }

      // Multiple results - format them for display
      const formattedResults = results.map((result, index) =>
        `${index + 1}. ${result.display_name} (${result.type})`
      ).join('\n');

      return {
        content: [{
          type: 'text' as const,
          text: [
            `Multiple locations found for "${location}":`,
            '',
            formattedResults,
            '',
            'Please use the select-location tool to choose one, or use get-weather-for-location which will prompt you to select.',
          ].join('\n'),
        }],
      };
    }
  );

  // Register tool to select a specific location from geocoding results
  server.registerTool(
    'select-location',
    {
      title: 'Select Location',
      description: 'Select a specific location from geocoding results by index',
      inputSchema: z.object({
        query: z.string().describe('The original location query'),
        index: z.number().min(0).describe('The index of the location to select (0-based)'),
      }),
    },
    async ({ query, index }) => {
      const cached = recentGeocodingResults.find((r) => r.query === query);
      
      if (!cached || cached.results.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `No cached results found for query: ${query}. Please run geocode first.`,
          }],
        };
      }

      if (index >= cached.results.length) {
        return {
          content: [{
            type: 'text' as const,
            text: `Invalid index ${index}. Available indices: 0-${cached.results.length - 1}`,
          }],
        };
      }

      const result = cached.results[index];
      return {
        content: [{
          type: 'text' as const,
          text: [
            `Selected: ${result.display_name}`,
            `Latitude: ${result.lat}`,
            `Longitude: ${result.lon}`,
            `Type: ${result.type}`,
          ].join('\n'),
        }],
      };
    }
  );

  // Register weather tool
  server.registerTool(
    'get-weather',
    {
      title: 'Get Weather',
      description: 'Get current weather for specific coordinates',
      inputSchema: z.object({
        latitude: z.number().min(-90).max(90).describe('Latitude of the location'),
        longitude: z.number().min(-180).max(180).describe('Longitude of the location'),
      }),
    },
    async ({ latitude, longitude }) => {
      const weatherData = await getWeather(latitude, longitude);

      if (!weatherData) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Failed to retrieve weather data',
          }],
        };
      }

      const { current_weather } = weatherData;
      const description = getWeatherDescription(current_weather.weathercode);

      return {
        content: [{
          type: 'text' as const,
          text: [
            `Weather for ${latitude.toFixed(4)}, ${longitude.toFixed(4)}:`,
            '',
            `Condition: ${description}`,
            `Temperature: ${current_weather.temperature}°C`,
            `Wind Speed: ${current_weather.windspeed} km/h`,
            `Wind Direction: ${current_weather.winddirection}°`,
            `Last Updated: ${current_weather.time}`,
            `Timezone: ${weatherData.timezone}`,
          ].join('\n'),
        }],
      };
    }
  );

  // Convenience tool to get weather by geocoding result index
  server.registerTool(
    'get-weather-by-index',
    {
      title: 'Get Weather by Index',
      description: 'Get weather for a location from recent geocoding results by index',
      inputSchema: z.object({
        query: z.string().describe('The original location query'),
        index: z.number().min(0).describe('The index of the location (0-based)'),
      }),
    },
    async ({ query, index }) => {
      const cached = recentGeocodingResults.find((r) => r.query === query);
      
      if (!cached || cached.results.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `No cached results found for query: ${query}. Please run geocode first.`,
          }],
        };
      }

      if (index >= cached.results.length) {
        return {
          content: [{
            type: 'text' as const,
            text: `Invalid index ${index}. Available indices: 0-${cached.results.length - 1}`,
          }],
        };
      }

      const result = cached.results[index];
      const latitude = parseFloat(result.lat);
      const longitude = parseFloat(result.lon);

      const weatherData = await getWeather(latitude, longitude);

      if (!weatherData) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Failed to retrieve weather data',
          }],
        };
      }

      const { current_weather } = weatherData;
      const description = getWeatherDescription(current_weather.weathercode);

      return {
        content: [{
          type: 'text' as const,
          text: [
            `Weather for ${result.display_name}:`,
            '',
            `Condition: ${description}`,
            `Temperature: ${current_weather.temperature}°C`,
            `Wind Speed: ${current_weather.windspeed} km/h`,
            `Wind Direction: ${current_weather.winddirection}°`,
            `Last Updated: ${current_weather.time}`,
          ].join('\n'),
        }],
      };
    }
  );

  // Tool that demonstrates elicitation for location selection
  server.registerTool(
    'get-weather-for-location',
    {
      title: 'Get Weather for Location',
      description: 'Get weather for a location by name. When multiple locations are obviously the same, use best guess. When multiple locations are clearly different, uses elicitation to select from available matches.',
      inputSchema: z.object({
        location: z.string().describe('Location name or address'),
      }),
    },
    async ({ location }, extra): Promise<CallToolResult> => {
      // First, geocode the location
      const results = await geocodeLocation(location);

      if (results.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `No results found for location: ${location}`,
          }],
        };
      }

      let selectedResult: NominatimResult;

      if (results.length === 1) {
        // Only one result, use it directly
        selectedResult = results[0];
      } else {
        // Multiple results - use elicitation to let user choose
        // Format the options list for the message
        const optionsList = results.map((r, index) => 
          `  ${index}: ${r.display_name} (${r.type})`
        ).join('\n');
        
        try {
          const elicitResult = await extra.sendRequest(
            {
              method: 'elicitation/create',
              params: {
                mode: 'form',
                message: `Multiple locations found for "${location}":\n\n${optionsList}\n\nPlease select one:`,
                requestedSchema: {
                  type: 'object',
                  properties: {
                    selection: {
                      type: 'string',
                      title: 'Location',
                      description: 'Select the location number',
                      enum: results.map((_, index) => index.toString()),
                      enumNames: results.map((r) => `${r.display_name} (${r.type})`),
                    },
                  },
                  required: ['selection'],
                },
              },
            },
            ElicitResultSchema
          );

          if (elicitResult.action === 'accept' && elicitResult.content) {
            const selectedIndex = parseInt((elicitResult.content as { selection: string }).selection, 10);
            selectedResult = results[selectedIndex];
          } else if (elicitResult.action === 'decline') {
            return {
              content: [{
                type: 'text' as const,
                text: 'Location selection was declined.',
              }],
            };
          } else {
            return {
              content: [{
                type: 'text' as const,
                text: 'Location selection was cancelled.',
              }],
            };
          }
        } catch (error) {
          return {
            content: [{
              type: 'text' as const,
              text: `Error during location selection: ${error}`,
            }],
          };
        }
      }

      // Now get weather for the selected location
      const latitude = parseFloat(selectedResult.lat);
      const longitude = parseFloat(selectedResult.lon);

      const weatherData = await getWeather(latitude, longitude);

      if (!weatherData) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Failed to retrieve weather data',
          }],
        };
      }

      const { current_weather } = weatherData;
      const description = getWeatherDescription(current_weather.weathercode);

      return {
        content: [{
          type: 'text' as const,
          text: [
            `Weather for ${selectedResult.display_name}:`,
            `Coordinates: ${latitude.toFixed(4)}, ${longitude.toFixed(4)}`,
            '',
            `Condition: ${description}`,
            `Temperature: ${current_weather.temperature}°C`,
            `Wind Speed: ${current_weather.windspeed} km/h`,
            `Wind Direction: ${current_weather.winddirection}°`,
            `Last Updated: ${current_weather.time}`,
            `Timezone: ${weatherData.timezone}`,
          ].join('\n'),
        }],
      };
    }
  );
  //#endregion registerTools

  //#region registerResources
  // Register resource for recent geocoding results
  server.registerResource(
    'geocoding-results',
    'geocoding://recent',
    {
      title: 'Recent Geocoding Results',
      description: 'List of recent geocoding queries and their results',
      mimeType: 'application/json',
    },
    async (): Promise<ReadResourceResult> => {
      return {
        contents: [{
          uri: 'geocoding://recent',
          mimeType: 'application/json',
          text: JSON.stringify(recentGeocodingResults, null, 2),
        }],
      };
    }
  );
  //#endregion registerResources

  //#region registerPrompts
  // Register prompt for getting weather
  server.registerPrompt(
    'weather-by-location',
    {
      title: 'Get Weather by Location',
      description: 'A prompt template to help get weather information for a location',
      argsSchema: {
        location: z.string().describe('The location to get weather for'),
      },
    },
    async ({ location }): Promise<GetPromptResult> => {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Please get the current weather for ${location}. Use the get-weather-for-location tool which will handle geocoding and location selection if needed.`,
            },
          },
        ],
      };
    }
  );
  //#endregion registerPrompts

  return server;
};
//#endregion createServer

//#region main
const MCP_PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : 3000;

const app = createMcpExpressApp();

// Map to store transports by session ID
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

// MCP POST endpoint
const mcpPostHandler = async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (sessionId) {
    console.log(`Received MCP request for session: ${sessionId}`);
  }

  try {
    let transport: StreamableHTTPServerTransport;
    if (sessionId && transports[sessionId]) {
      // Reuse existing transport
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // New initialization request
      const eventStore = new InMemoryEventStore();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        eventStore, // Enable resumability
        onsessioninitialized: (sessionId) => {
          console.log(`Session initialized with ID: ${sessionId}`);
          transports[sessionId] = transport;
        },
      });

      // Set up onclose handler to clean up transport when closed
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          console.log(`Transport closed for session ${sid}, removing from transports map`);
          delete transports[sid];
        }
      };

      // Connect the transport to the MCP server
      const server = getServer();
      await server.connect(transport);

      await transport.handleRequest(req, res, req.body);
      return;
    } else {
      // Invalid request
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: No valid session ID provided',
        },
        id: null,
      });
      return;
    }

    // Handle the request with existing transport
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('Error handling MCP request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
        },
        id: null,
      });
    }
  }
};

app.post('/mcp', mcpPostHandler);

// Handle GET requests for SSE streams
const mcpGetHandler = async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }

  // Check for Last-Event-ID header for resumability
  const lastEventId = req.headers['last-event-id'] as string | undefined;
  if (lastEventId) {
    console.log(`Client reconnecting with Last-Event-ID: ${lastEventId}`);
  } else {
    console.log(`Establishing new SSE stream for session ${sessionId}`);
  }

  const transport = transports[sessionId];
  await transport.handleRequest(req, res);
};

app.get('/mcp', mcpGetHandler);

// Handle DELETE requests for session termination
const mcpDeleteHandler = async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }

  console.log(`Received session termination request for session ${sessionId}`);

  try {
    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error('Error handling session termination:', error);
    if (!res.headersSent) {
      res.status(500).send('Error processing session termination');
    }
  }
};

app.delete('/mcp', mcpDeleteHandler);

app.listen(MCP_PORT, () => {
  console.log(`Weather MCP Server listening on port ${MCP_PORT}`);
  console.log(`MCP endpoint: http://localhost:${MCP_PORT}/mcp`);
});

// Handle server shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down server...');

  // Close all active transports
  for (const sessionId in transports) {
    try {
      console.log(`Closing transport for session ${sessionId}`);
      await transports[sessionId].close();
      delete transports[sessionId];
    } catch (error) {
      console.error(`Error closing transport for session ${sessionId}:`, error);
    }
  }
  console.log('Server shutdown complete');
  process.exit(0);
});
//#endregion main