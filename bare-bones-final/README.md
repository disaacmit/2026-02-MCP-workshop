# Creating a baseline MCP Server using the MCP TypeScript SDK

Follow this tutorial to create a simple MCP server with an example tool, resource, and prompt.

For more baseline examples, see the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).

## Requirements

- [Node.js](https://nodejs.org/) (LTS recommended)
- npm (included with Node.js)
- [Visual Studio Code](https://code.visualstudio.com/)
- For testing in Claude:
  - [Claude.ai account](https://claude.ai) (MCP support is available for all account types)
  - [Claude Desktop app](https://claude.ai/download), available for macOS and Windows

## Build an MCP server from scratch

### Step 1: Create a Node.js project

Initialize a new project and go to the folder:

```bash
mkdir 01-bare-bones
cd 01-bare-bones
npm init -y
```

Set project metadata and scripts:

```bash
npm pkg set type=module
npm pkg set name=01-bare-bones version=1.0.0 license=ISC
npm pkg set "bin.tip-calculator=./build/index.js"
npm pkg set "scripts.build=tsc && chmod 755 build/index.js"
npm pkg set "scripts.dev=tsx watch src/index.ts"
npm pkg set "files[0]=build"
npm pkg set main=index.js
```

Install dependencies:

```bash
npm i @modelcontextprotocol/sdk zod
npm i -D typescript @types/node tsx
```

### Step 2: Set up TypeScript

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./build",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
```

### Step 3: Add the MCP server

Create `src/index.ts`:

```typescript
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
```

### Step 4: Build the server

```bash
npm run build
```

## Run MCP server in dev mode

For local iteration:

```bash
npm run dev
```

## Run MCP server from build output

This server uses stdio and is intended to be launched by an MCP-compatible host.

```bash
node build/index.js
```

## Test with the MCP Inspector

Run the Inspector:

```bash
npx @modelcontextprotocol/inspector node build/index.js
```

If needed, you can also open the Inspector UI separately and configure:
- transport: `stdio`
- command: `node`
- args: `["/absolute/path/to/01-bare-bones/build/index.js"]`

## Try it in MCP Inspector

After connecting the server, test each primitive:

### Tool example: `calculate-tip`

```json
{
  "bill_amount": 120,
  "tip_percentage": 0.18
}
```

### Resource example: `greeting://Morten`

Read resource URI:

```text
greeting://Morten
```

Expected content:

```text
Hello, Morten!
```

### Prompt example: `greet-user`

```json
{
  "name": "Morten",
  "style": "formal"
}
```

This returns a prompt message instructing the model to produce a formal Danish greeting.

## Run MCP server in VS Code

1. Open Command Palette (`Shift+Cmd/Ctrl+P`)
2. Select `MCP: Open User Configuration` (this opens `mcp.json`)
3. In `mcp.json`:

```json
{
  "servers": {
    "tip-calculator": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/absolute/path/to/01-bare-bones/build/index.js"
      ]
    }
  },
  "inputs": []
}
```

## Run MCP server in Claude Desktop

1. Open `claude_desktop_config.json` in an editor.

   File location:
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\\Claude\\claude_desktop_config.json`

2. Add the server:

```json
{
  "mcpServers": {
    "Tip Calculator": {
      "command": "node",
      "args": [
        "/absolute/path/to/01-bare-bones/build/index.js"
      ]
    }
  }
}
```
