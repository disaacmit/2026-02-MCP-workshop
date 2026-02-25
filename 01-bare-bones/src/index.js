#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
var stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
// Set up the server
var server = new mcp_js_1.McpServer({
    name: 'tip-calculator',
    version: '1.0.0',
});
// Create a STDIO transport for the server
await server.connect(new stdio_js_1.StdioServerTransport());
