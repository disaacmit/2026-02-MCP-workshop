# Weather MCP Server

An example MCP server demonstrating key features in a practical weather application. 

This server connects to two different keyless APIs to combine geocoding (converting location names to coordinates) with weather data retrieval and uses `tools`, `resources`, `prompts`, `elicitation`, and HTTP streaming transport.

## How the server works

When the user asks for weather information in their AI app, the MCP server:

1. Converts location names to geographic coordinates using the [Nominatim API](https://nominatim.org/) (OpenStreetMap)
2. Fetches current weather data for those coordinates using the [Open-Meteo API](https://open-meteo.com/)
3. Handles ambiguous location queries through interactive elicitation
4. Maintains state across requests using session management
5. Exposes recent queries as resources for inspection

Both APIs are free and require no API keys.

## Setup and Testing with MCPJam

MCPJam is a browser-based inspector for MCP servers, MCP Apps, and ChatGPT Apps. Here's how to use it to test your MCP server:

### 1. Build the Server

```bash
cd 02-weather-mcp-server
npm install
npm run build
```

### 2. Start the Server

```bash
npm start
```

The server will start on port 3000 (configurable via `MCP_PORT` environment variable). You should see:

```
Weather MCP Server listening on port 3000
MCP endpoint: http://localhost:3000/mcp
```

### 3. Install and run MCPJam:

1. Install MCPJam from terminal:
   ```bash
   npx @mcpjam/inspector@latest
   ```
2. Select "HTTP" as the transport type
3. Enter the server URL: `http://localhost:3000/mcp`
4. Click "Connect"

MCPJam will perform the MCP initialization handshake and display the available tools, resources, and prompts.

### 4. Test the Tools

Try these interactions in the MCPJam chat:

**Get weather for an unambiguous location:**
Ask about the weather in an unambiguous location like "Oslo"

**Trigger elicitation with an ambiguous location:**
Try an ambiguous location like "London"

**Geocode a location manually:**
Ask for the geocode for a location

**Get weather by coordinates:**

Plug the geocode data into the chat and ask for weather at that location

### 5. Inspect Resources

In MCPJam, navigate to the Resources section and select `geocoding://recent`. This will show you a JSON list of all recent geocoding queries the server has performed, demonstrating how resources provide server state to clients.

### 6. Use Prompts

Select the `weather-by-location` prompt and provide a location name. This demonstrates how prompts provide pre-built templates that clients can use to construct requests.

## Under the hood

### Tools

This server registers five tools, demonstrating different patterns:

#### 1. `geocode`
Converts a location name to coordinates using the Nominatim API.

**Input schema:** `{ location: string }`

**What it demonstrates:**
- Basic tool registration with input validation using Zod
- External API integration
- Handling single vs. multiple results
- Caching results for later use

**Code highlights:**
```typescript
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
    // ... handle results
  }
);
```

#### 2. `get-weather`
Retrieves weather data for specific coordinates.

**Input schema:** `{ latitude: number, longitude: number }`

**What it demonstrates:**
- Numeric validation with range constraints (latitude: -90 to 90, longitude: -180 to 180)
- External API integration with Open-Meteo
- Structured text responses

#### 3. `select-location`
Selects a specific result from cached geocoding results by index.

**Input schema:** `{ query: string, index: number }`

**What it demonstrates:**
- State management using the in-memory cache
- Error handling for invalid indices or missing cache entries
- Multi-step tool workflows

#### 4. `get-weather-by-index`
Convenience tool combining `select-location` and `get-weather`.

**Input schema:** `{ query: string, index: number }`

**What it demonstrates:**
- Tool composition (combining multiple operations)
- Reducing client-side complexity

#### 5. `get-weather-for-location`
The most sophisticated tool - geocodes a location and gets weather, using elicitation when multiple results are found.

**Input schema:** `{ location: string }`

**What it demonstrates:**
- **Elicitation**: When multiple locations match (e.g., "Portland"), the server sends an `elicitation/create` request back to the client with a form containing the options
- **Request context**: Uses the `extra` parameter to send requests back to the client during tool execution
- **Form-based interaction**: Creates a dropdown selection interface in the client
- **Graceful handling**: Deals with accept, decline, and cancel actions from the user

**Code highlight showing elicitation:**
```typescript
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
```

### Resources

**Resource:** `geocoding://recent`

Resources allow servers to expose data that clients can read. This server exposes recent geocoding results as a JSON resource.

**What it demonstrates:**
- Resource registration with URI scheme (`geocoding://`)
- MIME type specification (`application/json`)
- Dynamic resource content (updates as new queries are made)
- In-memory state management

**How it works:**
Every time a geocoding query is performed, the results are stored in an array limited to the 10 most recent queries. Clients can read this resource to see query history.

**Code structure:**
```typescript
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
```

### Prompts

**Prompt:** `weather-by-location`

Prompts are pre-built message templates that help guide client interactions.

**What it demonstrates:**
- Prompt registration with arguments
- Prompt composition (creating user messages)
- Reducing complexity for common operations

**Why it's useful:**
Instead of clients figuring out which tool to call and how to handle multi-step interactions, they can use this prompt template which provides clear instructions.

**Code structure:**
```typescript
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
```

### HTTP Transport with Session Management

This server uses `StreamableHTTPServerTransport` instead of stdio, which demonstrates:

**Session Management:**
- Each client connection gets a unique session ID (UUID)
- Sessions persist across multiple requests
- State (like geocoding cache) is maintained per server instance

**HTTP Endpoints:**
- `POST /mcp` - Main MCP request/response endpoint
- `GET /mcp` - Server-Sent Events (SSE) stream for notifications
- `DELETE /mcp` - Session termination

**Resumability:**
The server uses `InMemoryEventStore` to enable resumability. If a client disconnects during an SSE stream, it can reconnect and resume from where it left off using the `Last-Event-ID` header.

**Code structure:**
```typescript
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),
  eventStore, // Enables resumability
  onsessioninitialized: (sessionId) => {
    console.log(`Session initialized with ID: ${sessionId}`);
    transports[sessionId] = transport;
  },
});
```

## Ideas for Experimentation and Extension

Here are ways to modify this server to deepen your understanding of MCP:

### Beginner Experiments

1. **Add a new weather parameter:**
   - Modify `get-weather` to accept a `units` parameter (metric or imperial)
   - Update the Open-Meteo API call to include `temperature_unit` and `windspeed_unit`
   - Change the response formatting based on the selected units

2. **Create a favorites resource:**
   - Add a new array to store favorite locations
   - Create a tool `add-favorite` that saves a location
   - Create a resource `favorites://list` that returns saved locations
   - Create a tool `get-weather-for-favorite` that uses the favorites

3. **Add more weather data:**
   - The Open-Meteo API returns much more than just current weather
   - Add parameters like humidity, precipitation, or UV index
   - Update the response formatting to include these new fields

4. **Better weather descriptions:**
   - The `getWeatherDescription` function has limited weather codes
   - Add more weather codes from the Open-Meteo documentation
   - Add wind direction descriptions (N, NE, E, SE, etc.) based on degrees

### Intermediate Experiments

5. **Add forecast functionality:**
   - Create a new tool `get-forecast` that takes location and number of days
   - Use Open-Meteo's forecast API endpoint
   - Format the multi-day forecast data clearly
   - Consider using elicitation to let users select how many days

6. **Implement location history:**
   - Track which locations users request weather for
   - Create a resource `history://weather-requests` showing request history
   - Add timestamps and organize by frequency

7. **Add validation and error handling:**
   - Handle network failures gracefully with retry logic
   - Validate API responses before processing
   - Provide more helpful error messages
   - Add timeouts for API requests

8. **Multiple geocoding services:**
   - Add support for alternative geocoding APIs (Google Maps, Mapbox, etc.)
   - Create a tool parameter to select which service to use
   - Compare results from different services

### Advanced Experiments

9. **Weather alerts:**
   - Integrate Open-Meteo's weather alerts API
   - Create a tool `get-weather-alerts` for a location
   - Use elicitation to show multiple active alerts and let users select one for details

10. **Streaming weather updates:**
    - Modify `get-weather` to emit progress notifications via SSE
    - Show "Geocoding...", "Fetching weather...", "Formatting response..." steps
    - Demonstrates the streaming capabilities of the HTTP transport

11. **Caching and optimization:**
    - Add a TTL (time-to-live) to cached weather results
    - Return cached results if requested within X minutes
    - Add a resource showing cache statistics
    - Implement cache invalidation

12. **Multi-location comparisons:**
    - Create a tool `compare-weather` that takes multiple locations
    - Fetch weather for each location concurrently
    - Return a formatted comparison table
    - Use elicitation to handle ambiguous locations in the list

13. **Custom prompt chains:**
    - Create a prompt `plan-outdoor-activity` that chains multiple tools
    - Get weather, check if conditions are suitable, suggest alternatives
    - Demonstrates complex prompt composition

14. **Authentication and rate limiting:**
    - Add API key requirement for certain tools
    - Implement rate limiting per session
    - Track usage in a resource `stats://usage`
    - Demonstrate security considerations


