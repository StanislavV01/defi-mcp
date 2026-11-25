#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";

const server = new McpServer({ name: "defi-mcp", version: "0.1.0" });
registerTools(server);

await server.connect(new StdioServerTransport());
// stdout is the MCP channel — log to stderr only.
console.error("defi-mcp running on stdio");
