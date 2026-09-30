---
name: basic-host calls view-registered tools
description: Let basic-host discover and call tools that an MCP App registers inside its iframe via app.registerTool()
status: in-progress
created: 2026-09-30
updated: 2026-09-30
---

# basic-host calls view-registered tools

## Goal

Make `examples/basic-host` a working reference host for **view-registered tools**: tools an MCP App registers inside its HTML page with `app.registerTool(...)`, as opposed to tools the MCP server registers.

Today basic-host renders such apps, but it cannot list or call their tools. So there is no way to prove, by hand or in CI, that a tool registered in the iframe works end to end. When this spec is done, a developer can:

1. Start `examples/map-server` and basic-host.
2. Call `show-map` to render the globe.
3. See the view's tools (`navigate-to`, `get-current-view`) listed under the rendered app.
4. Call `navigate-to` with JSON arguments, watch the globe fly there, and see the tool result.
5. Call `get-current-view` and get back the new camera position and bounding box.

## Background

### How view tools work in the SDK (already implemented)

| Side        | API                                                                                                                                                                                                                                               | File                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| View        | `app.registerTool(name, config, cb)` stores the tool and installs `tools/list` and `tools/call` request handlers on the view's `Protocol`. If this runs **before** `connect()`, it auto-declares `appCapabilities.tools = { listChanged: true }`. | `src/app.ts:~590-690`    |
| View        | Calls `sendToolListChanged()` when a tool is added, updated, enabled or disabled after initialization.                                                                                                                                            | `src/app.ts:~605, 737`   |
| View → Host | Sends `appCapabilities` in `ui/initialize`, and the bridge stores it.                                                                                                                                                                             | `src/app-bridge.ts:1637` |
| Host        | `bridge.getAppCapabilities()` returns those capabilities.                                                                                                                                                                                         | `src/app-bridge.ts:~623` |
| Host → View | `bridge.listTools(params)` sends `tools/list` to the view.                                                                                                                                                                                        | `src/app-bridge.ts:1942` |
| Host → View | `bridge.callTool(params)` sends `tools/call` to the view.                                                                                                                                                                                         | `src/app-bridge.ts:1929` |

Spec reference: `specification/2026-01-26/apps.mdx` under "App Capabilities in `ui/initialize`". The `McpUiAppCapabilities.tools` comment reads: "App exposes MCP-style tools that the host can call."

Host-to-view requests are not capability-gated in `AppBridge` (`assertCapabilityForMethod` is a no-op). The host is responsible for checking `getAppCapabilities()?.tools` before calling.

### What basic-host does today (the gap)

- `examples/basic-host/src/implementation.ts:40` calls `listTools()` on the **MCP server client** only.
- `examples/basic-host/src/implementation.ts:101` calls `callTool()` on the **MCP server client** only.
- It never calls `appBridge.listTools()` or `appBridge.callTool()`, and nothing else in the repo does either.
- It has no handler for `notifications/tools/list_changed` sent **from the view**. The existing forwarding in `AppBridge.connect()` (`src/app-bridge.ts:~2023`) goes the other way, from the server to the view.
- The `AppBridge` instance is private to the `AppIFramePanel` component (`appBridgeRef`), and the UI outside that component cannot reach it.

### Examples that register view tools (all affected by this change)

- `examples/map-server/src/mcp-app.ts`: `navigate-to`, `get-current-view` (registered at module scope, before `app.connect()` at line ~1008)
- `examples/budget-allocator-server/src/mcp-app.ts`
- `examples/pdf-server/src/mcp-app.ts`
- `examples/shadertoy-server/src/mcp-app.ts`
- `examples/threejs-server/src/mcp-app-wrapper.tsx`
- `examples/wiki-explorer-server/src/mcp-app.ts`

## Non-goals

- **No LLM integration.** A real host would add view tools to the model's tool list. basic-host has no model, so a human calls the tools through the UI instead.
- **No SDK changes**, unless Open question 1 finds that one is needed. Everything required already exists in `AppBridge`.
- **No cross-app routing.** Each view's tools belong to that view's panel only. There is no global "call a tool on whichever app" picker.
- **No `ui/`-namespaced alternatives.** The protocol uses plain MCP `tools/list` and `tools/call` on the iframe channel.

## Design

### 1. `examples/basic-host/src/implementation.ts`

#### 1a. New helpers

```ts
/** True if the view declared the `tools` app capability in ui/initialize. */
export function viewHasTools(appBridge: AppBridge): boolean {
  return !!appBridge.getAppCapabilities()?.tools;
}

/** List all tools the view registered (follows pagination cursors). */
export async function listViewTools(appBridge: AppBridge): Promise<Tool[]> {
  if (!viewHasTools(appBridge)) return [];
  const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const result = await appBridge.listTools(cursor ? { cursor } : {});
    tools.push(...result.tools);
    cursor = result.nextCursor;
  } while (cursor);
  log.info(
    "View tools:",
    tools.map((t) => t.name),
  );
  return tools;
}

/** Call a tool registered by the view (NOT the MCP server). */
export async function callViewTool(
  appBridge: AppBridge,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  log.info("Calling view tool", name, "with input", args);
  const result = (await appBridge.callTool({
    name,
    arguments: args,
  })) as CallToolResult;
  log.info("View tool result:", result);
  return result;
}
```

- Must be called only **after** `oninitialized` has fired. Before then, the view's handlers and capabilities are not known.
- Protocol errors (unknown tool, schema validation failure, timeout) reject the promise. Tool-level failures resolve with `isError: true`. The UI must show both clearly (see 2c).

#### 1b. Listen for `notifications/tools/list_changed` from the view

Add to `AppBridgeCallbacks`:

```ts
onViewToolsChanged?: () => void;
```

In `newAppBridge()`, register this **before** `connect()`, alongside the other handlers:

```ts
appBridge.setNotificationHandler("notifications/tools/list_changed", () => {
  log.info("View tool list changed");
  callbacks?.onViewToolsChanged?.();
});
```

- `AppBridge.setNotificationHandler` throws if the method is already claimed. Confirm that `connect()`'s automatic server→view forwarding does not claim `notifications/tools/list_changed` on the **bridge**. It registers on `this._client` (the MCP server client), so it should not. See Open question 1.
- This handler is what picks up tools the view registers, enables, disables or removes after initialization.

#### 1c. Signal "app initialized" to the UI

`initializeApp()` already awaits initialization internally but returns only after `sendToolInput`. That return point is late enough, so the UI can chain on it:

```ts
initializeApp(iframe, appBridge, toolCallInfo).then(() => setBridgeReady(true));
```

No signature change is needed. Optionally, rename or clarify the doc comment to state that the promise resolves once the view is initialized and has received its tool input.

### 2. `examples/basic-host/src/index.tsx`

#### 2a. `AppIFramePanel` state

Add to the `AppIFramePanel` component:

```ts
const [bridgeReady, setBridgeReady] = useState(false);
const [viewTools, setViewTools] = useState<Tool[] | null>(null); // null = view has no tools capability
const refreshViewTools = useCallback(async () => {
  const bridge = appBridgeRef.current;
  if (!bridge) return;
  if (!viewHasTools(bridge)) {
    setViewTools(null);
    return;
  }
  try {
    setViewTools(await listViewTools(bridge));
  } catch (e) {
    log.error("tools/list on view failed:", e);
    setViewTools([]);
  }
}, []);
```

Wiring:

- Pass `onViewToolsChanged: refreshViewTools` into `newAppBridge(...)` callbacks. Use a ref or a stable callback so the Strict Mode double effect does not register it twice. The existing `firstTime` guard already prevents double bridge creation.
- After `initializeApp(...)` resolves, call `setBridgeReady(true)` and then `refreshViewTools()`.
- On teardown (`isDestroying`), disable the panel so no calls are sent to a closing view.

#### 2b. New `ViewToolsPanel` component

Render it inside `AppIFramePanel`, below the `<iframe>` and above the Messages and Model Context panels, only when `bridgeReady && viewTools !== null`.

```tsx
interface ViewToolsPanelProps {
  tools: Tool[];
  disabled: boolean;
  onCall: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<CallToolResult>;
}
```

UI:

- Header: `🧩 View Tools (N)`. Make it collapsible and **collapsed by default** so existing screenshots change as little as possible.
- When `tools.length === 0`, show "View declares tools capability but registered none."
- Tool `<select>` listing `tool.name`, with `title` or `description` as tooltip or subtext.
- Read-only `<pre>` of the selected tool's `inputSchema` (collapsible). This helps the user write arguments.
- `<textarea>` for JSON arguments, pre-filled with `getToolDefaults(tool)` (reuse the existing helper) and `aria-invalid` when invalid, like the main panel.
- Submit button labelled **"Call View Tool"**. It must **not** contain the substring "Call Tool", because `tests/e2e/servers.spec.ts` uses `button:has-text("Call Tool")`, and a second match would break Playwright strict mode.
- The button is disabled while `disabled`, while the JSON is invalid, or while a call is in flight.
- Results list (newest first). Each entry is a `CollapsiblePanel` with:
  - label: `📤 <toolName>`
  - badge: `ok` / `isError` / `error`
  - content: pretty JSON of the `CallToolResult`, or the error message for a rejected promise.

#### 2c. Error presentation

| Case                                                 | Source                                            | Display                                                    |
| ---------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------- |
| Tool returned `isError: true`                        | view callback                                     | Result panel with badge `isError`, content = result JSON   |
| Unknown tool / disabled tool / arg validation failed | view `tools/call` handler throws → JSON-RPC error | Result panel with badge `error`, content = `error.message` |
| Timeout (default `Protocol` request timeout)         | `AppBridge.request`                               | Same as above                                              |
| View has no `tools` capability                       | `getAppCapabilities()`                            | Panel not rendered                                         |

#### 2d. Fullscreen mode

In `index.module.css`, `.appIframePanel.fullscreen .collapsiblePanel { display: none; }` hides child panels in fullscreen. The View Tools panel should stay hidden in fullscreen too, for consistency. Give it a class that the fullscreen rule also hides, or accept that it is hidden. Calling view tools from fullscreen is out of scope.

### 3. `examples/basic-host/src/index.module.css`

- Add `.viewToolsPanel` styles, reusing the form layout of `.callToolPanel` (labels, select, textarea, button) at a smaller, nested scale.
- Add it to the fullscreen hide rule (see 2d).

### 4. Optional debug hook (recommended)

For console-driven testing and simpler e2e assertions, expose live bridges in development only:

```ts
// implementation.ts
declare global {
  interface Window {
    __basicHostBridges?: Map<number, AppBridge>;
  }
}
```

Register in `AppIFramePanel` when the bridge is created, keyed by tool call id, and delete on teardown. Then in the browser console:

```js
const b = [...__basicHostBridges.values()][0];
await b.listTools({});
await b.callTool({ name: "get-current-view", arguments: {} });
```

Guard with `import.meta.env.DEV` so production builds don't expose it.

### 5. Documentation

- `examples/basic-host/README.md`: add a section **"Calling tools registered by the view"**. It explains `app.registerTool`, where the panel appears, and a map-server walkthrough with sample `navigate-to` arguments:
  ```json
  { "west": -0.5, "south": 51.3, "east": 0.3, "north": 51.7, "label": "London" }
  ```
  Update the "Key Files" bullet for `src/index.tsx` to mention the view tools panel.
- `docs/testing-mcp-apps.md`: in the basic-host section, add a line saying that tools registered with `app.registerTool()` can be listed and called from the **View Tools** panel under the rendered app.

### 6. Tests

#### 6a. New e2e spec: `tests/e2e/view-tools.spec.ts`

Use map-server as the primary target. It is slow because CesiumJS loads from a CDN, so use the same ~15s allowance as `SLOW_SERVERS["map-server"]`. Budget-allocator is a faster secondary target if map-server proves flaky in CI.

Test cases:

1. **lists view tools**: load "CesiumJS Map Server" (same flow as `loadServer` in `servers.spec.ts`), expand View Tools, and assert the select contains `navigate-to` and `get-current-view`.
2. **calls get-current-view**: select it, submit `{}`, and assert the result panel shows badge `ok` and the content contains `"camera"`.
3. **calls navigate-to**: submit the London bbox, and assert the result text contains `Navigated to:` and `(London)`. Then call `get-current-view` and assert the returned `bbox` roughly overlaps the requested one (loose numeric tolerance, because Cesium may pad the view).
4. **error path**: submit `navigate-to` with `{}` (missing required fields), and assert a result with badge `error` or `isError`.
5. **no panel for apps without view tools**: load a `basic-server-*` app and assert the View Tools panel is absent.

Extract the helpers (`loadServer`, `getAppFrame`, `waitForAppLoad`) from `servers.spec.ts` into `tests/e2e/helpers.ts`, or duplicate them minimally.

#### 6b. Existing screenshot snapshots

`servers.spec.ts` takes **full-page** screenshots (`toHaveScreenshot(\`${server.key}.png\`)`). A new collapsed panel will change the snapshots for the 6 servers listed above. Regenerate them in the Linux Docker image so they match CI:

```bash
npm run test:e2e:docker:update
```

Commit only the snapshots that changed for those 6 servers, and review each diff visually.

#### 6c. Selector safety checklist

- The new button text does not contain "Call Tool".
- The new `<select>` renders **after** the main server `<select>`, because `servers.spec.ts` uses `page.locator("select").first()`.
- `page.frameLocator("iframe").first()` still resolves to the sandbox iframe, because no new iframes are added.

## Acceptance criteria

- [ ] With map-server + basic-host, after calling `show-map`, a **View Tools** panel lists exactly `navigate-to` and `get-current-view`.
- [ ] Calling `navigate-to` with valid bbox JSON moves the globe and shows a result containing `Navigated to:`.
- [ ] Calling `get-current-view` returns JSON with `camera` and `bbox` that reflects the last navigation.
- [ ] Invalid arguments produce a visible error result, and the host does not crash.
- [ ] Apps that don't declare the `tools` capability show no View Tools panel.
- [ ] If a view registers, enables or disables a tool after init, the panel's list updates without reloading (via `notifications/tools/list_changed`).
- [ ] Closing the app panel disables the view tools UI, and no `tools/call` is sent after `teardownResource`.
- [x] `npm run --workspace examples/basic-host build` passes type-checking.
- [ ] `npm run test:e2e` passes, including the new `view-tools.spec.ts` and the regenerated snapshots.
- [x] README and `docs/testing-mcp-apps.md` are updated.

## Dependencies

- None on other specs.
- SDK: relies on the existing `AppBridge.listTools`, `AppBridge.callTool`, `AppBridge.getAppCapabilities` and `AppBridge.setNotificationHandler`, and on the existing `App.registerTool` behaviour.

## Open questions

1. ~~**Does the bridge accept `notifications/tools/list_changed` from the view?**~~ **Resolved: yes.** No SDK change needed; see the new test in `src/app-bridge.test.ts`. `AppBridge.setNotificationHandler` goes through `MethodRegistry.claim()` and the base `Protocol`. Confirm that registering it does not throw (no prior claim) and that the base `Protocol` parses the incoming notification. If it does not, a small SDK change may be needed, such as an `AppBridge.onviewtoollistchanged` setter. If so, split that into its own spec.
2. **Post-connect registration:** `App.registerTool` auto-declares the `tools` capability only **before** `connect()`. An app that registers its first tool after connecting will not advertise the capability, so basic-host will hide the panel. Should basic-host try `tools/list` anyway and hide the panel only on failure? Recommendation: no. Follow the capability strictly, since that is what a real host should do, and document the behaviour in the README.
3. **Debug hook (§4):** included behind `import.meta.env.DEV`, keyed by a per-panel counter (the `ToolCallEntry` id is not passed down to `AppIFramePanel`).
4. **Upstream vs fork:** this is being built on a fork first. Decide later whether to open an upstream PR against `modelcontextprotocol/ext-apps`.

## Progress

- [x] Investigate gap and write spec
- [x] Resolve open question 1 (bridge accepts view `tools/list_changed`): yes, no SDK change needed. Covered by a new test in `src/app-bridge.test.ts` ("view tool registration after connect notifies bridge of tools/list_changed").
- [x] `implementation.ts`: `viewHasTools`, `listViewTools`, `callViewTool`, `onViewToolsChanged` handler
- [x] `index.tsx`: `AppIFramePanel` state and wiring, `ViewToolsPanel` component
- [x] `index.module.css`: panel styles and fullscreen rule
- [x] Optional dev-only `window.__basicHostBridges` hook
- [x] Manual verification with map-server (confirmed by user)
- [x] `tests/e2e/view-tools.spec.ts`: 5/5 pass locally
- [ ] Regenerate affected screenshot snapshots (Docker). Not done: Docker unavailable locally. A local before/after run of `servers.spec.ts` shows no new screenshot failures, though many already fail on macOS and some are flaky timeouts.
- [ ] README and `docs/testing-mcp-apps.md` updates
