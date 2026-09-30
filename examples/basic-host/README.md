# Example: Basic Host

A reference implementation showing how to build an MCP host application that connects to MCP servers and renders tool UIs in a secure sandbox.

This basic host can also be used to test MCP Apps during local development.

## Key Files

- [`index.html`](index.html) / [`src/index.tsx`](src/index.tsx) - React UI host with tool selection, parameter input, iframe management, and the View Tools panel
- [`sandbox.html`](sandbox.html) / [`src/sandbox.ts`](src/sandbox.ts) - Outer iframe proxy with security validation and bidirectional message relay
- [`src/implementation.ts`](src/implementation.ts) - Core logic: server connection, tool calling, and AppBridge setup

## Getting Started

```bash
npm install
npm run start
# Open http://localhost:8080
```

By default, the host application will try to connect to an MCP server at `http://localhost:3001/mcp`. You can configure this behavior by setting the `SERVERS` environment variable with a JSON array of server URLs:

```bash
SERVERS='["http://localhost:1234/mcp", "http://localhost:5678/mcp"]' npm run start
```

## Calling tools registered by the view

An MCP App can register its own tools inside its HTML page with `app.registerTool()`. These are separate from the tools the MCP server registers. A real host exposes them to the model; basic-host has no model, so it lets you call them by hand.

If the view declares the `tools` capability in `ui/initialize` (which `app.registerTool()` does automatically when called **before** `app.connect()`), a collapsed **🧩 View Tools** panel appears under the rendered app. Expand it to pick a tool, see its input schema, enter JSON arguments, and click **Call View Tool**. Results appear newest first, with a badge:

- `ok`: the tool returned a result
- `isError`: the tool returned a result with `isError: true`
- `error`: the request failed (unknown tool, invalid arguments, timeout)

The list refreshes when the view sends `notifications/tools/list_changed`, for example after registering, enabling, or disabling a tool.

> [!NOTE]
> basic-host follows the capability strictly. An app that registers its first tool only **after** `connect()` does not advertise the `tools` capability, so no panel is shown.

For example, with `examples/map-server`, call `show-map`, expand View Tools, select `navigate-to` and call it with:

```json
{ "west": -0.5, "south": 51.3, "east": 0.3, "north": 51.7, "label": "London" }
```

The globe flies to London. Then call `get-current-view` to read back the camera position and bounding box.

In development builds, live bridges are also available from the browser console:

```js
const b = [...__basicHostBridges.values()][0];
await b.listTools({});
await b.callTool({ name: "get-current-view", arguments: {} });
```

## Architecture

This example uses a double-iframe sandbox pattern for secure UI isolation:

```
Host (port 8080)
  └── Outer iframe (port 8081) - sandbox proxy
        └── Inner iframe (srcdoc) - untrusted tool UI
```

**Why two iframes?**

- The outer iframe runs on a separate origin (port 8081) preventing direct access to the host
- The inner iframe receives HTML via `srcdoc` and is restricted by sandbox attributes
- Messages flow through the outer iframe which validates and relays them bidirectionally

This architecture ensures that even if tool UI code is malicious, it cannot access the host application's DOM, cookies, or JavaScript context.
