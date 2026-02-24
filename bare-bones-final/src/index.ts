#!/usr/bin/env node

import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({
  name: 'tip-calculator',
  version: '1.0.0',
});

server.registerTool(
  'calculate-tip',
  {
    title: 'Calculate Tip',
    description: 'Calculate the tip and total bill amount for a restaurant meal.',
    inputSchema: {
      bill_amount: z
        .number()
        .positive()
        .describe('The original bill amount in dollars (before tip)'),
      tip_percentage: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe('Tip percentage as a decimal fraction (e.g., 0.15, 0.18, 0.2). Defaults to 0.2'),
    },
  },
  async ({ bill_amount, tip_percentage }) => {
    const applied_tip_percentage = tip_percentage ?? 0.2;
    const tip_amount = bill_amount * applied_tip_percentage;
    const total_amount = bill_amount + tip_amount;

    const response = [
      `Bill Amount: $${bill_amount.toFixed(2)}`,
      `Tip Percentage: ${(applied_tip_percentage * 100).toFixed(0)}%`,
      `Tip Amount: $${tip_amount.toFixed(2)}`,
      `Total Amount: $${total_amount.toFixed(2)}`,
    ].join('\n');

    return {
      content: [
        {
          type: 'text' as const,
          text: response,
        },
      ],
    };
  }
);

server.registerResource(
  'greeting-resource',
  new ResourceTemplate('greeting://{name}', { list: undefined }),
  {
    title: 'Greeting Resource',
    description: 'Get a personalized greeting',
    mimeType: 'text/plain',
  },
  async (uri, { name }) => {
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/plain',
          text: `Hello, ${name}!`,
        },
      ],
    };
  }
);

server.registerPrompt(
  'greet-user',
  {
    title: 'Greet User',
    description: 'Generate a greeting request in different styles',
    argsSchema: {
      name: z.string().describe('Name of the person to greet'),
      style: z
        .enum(['friendly', 'formal', 'casual'])
        .optional()
        .describe('Tone style for the greeting request'),
    },
  },
  async ({ name, style = 'friendly' }) => {
    const styles = {
      friendly: 'Please write a warm, friendly greeting in Danish',
      formal: 'Please write a formal, professional greeting in Danish',
      casual: 'Please write a casual, relaxed greeting in Danish',
    } as const;

    return {
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `${styles[style]} for someone named ${name} in Danish.`,
          },
        },
      ],
    };
  }
);

await server.connect(new StdioServerTransport());