import { getToolUiResourceUri, McpUiToolMetaSchema } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import { Component, type ErrorInfo, type ReactNode, StrictMode, Suspense, use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { callTool, callViewTool, connectToServer, hasAppHtml, initializeApp, listViewTools, loadSandboxProxy, log, newAppBridge, viewHasTools, type ServerInfo, type ToolCallInfo, type ModelContext, type AppMessage } from "./implementation";
import { getTheme, toggleTheme, onThemeChange, type Theme } from "./theme";
import styles from "./index.module.css";

/**
 * Check if a tool is visible to the model (not app-only).
 * Tools with `visibility: ["app"]` should not be shown in tool lists.
 */
function isToolVisibleToModel(tool: { _meta?: Record<string, unknown> }): boolean {
  const result = McpUiToolMetaSchema.safeParse(tool._meta?.ui);
  if (!result.success) return true; // default: visible to model
  const visibility = result.data.visibility;
  if (!visibility) return true; // default: visible to model
  return visibility.includes("model");
}

/** Compare tools: UI-enabled first, then alphabetically by name. */
function compareTools(a: Tool, b: Tool): number {
  const aHasUi = !!getToolUiResourceUri(a);
  const bHasUi = !!getToolUiResourceUri(b);
  if (aHasUi && !bHasUi) return -1;
  if (!aHasUi && bHasUi) return 1;
  return a.name.localeCompare(b.name);
}

/**
 * Extract default values from a tool's JSON Schema inputSchema.
 * Returns a formatted JSON string with defaults, or "{}" if none found.
 */
function getToolDefaults(tool: Tool | undefined): string {
  if (!tool?.inputSchema?.properties) return "{}";

  const defaults: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(tool.inputSchema.properties)) {
    if (prop && typeof prop === "object" && "default" in prop) {
      defaults[key] = prop.default;
    }
  }

  return Object.keys(defaults).length > 0
    ? JSON.stringify(defaults, null, 2)
    : "{}";
}


// Host passes serversPromise to CallToolPanel
interface HostProps {
  serversPromise: Promise<ServerInfo[]>;
}

type ToolCallEntry = ToolCallInfo & { id: number };
let nextToolCallId = 0;

// Parse URL query params for debugging: ?server=name&tool=name&call=true&theme=hide
function getQueryParams() {
  const params = new URLSearchParams(window.location.search);
  return {
    server: params.get("server"),
    tool: params.get("tool"),
    call: params.get("call") === "true",
    hideThemeToggle: params.get("theme") === "hide",
  };
}

/**
 * Theme toggle button with light/dark icons.
 */
function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(getTheme);

  useEffect(() => {
    return onThemeChange(setTheme);
  }, []);

  return (
    <button
      className={styles.themeToggle}
      onClick={() => toggleTheme()}
      title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
    >
      {theme === "dark" ? "☀️" : "🌙"}
    </button>
  );
}


function Host({ serversPromise }: HostProps) {
  const [toolCalls, setToolCalls] = useState<ToolCallEntry[]>([]);
  const [destroyingIds, setDestroyingIds] = useState<Set<number>>(new Set());
  const queryParams = useMemo(() => getQueryParams(), []);

  const requestClose = (id: number) => {
    setDestroyingIds((s) => new Set(s).add(id));
  };

  const completeClose = (id: number) => {
    setDestroyingIds((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
    setToolCalls((calls) => calls.filter((c) => c.id !== id));
  };

  return (
    <>
      {!queryParams.hideThemeToggle && <ThemeToggle />}
      {toolCalls.map((info) => (
        <ToolCallInfoPanel
          key={info.id}
          toolCallInfo={info}
          isDestroying={destroyingIds.has(info.id)}
          onRequestClose={() => requestClose(info.id)}
          onCloseComplete={() => completeClose(info.id)}
        />
      ))}
      <CallToolPanel
        serversPromise={serversPromise}
        addToolCall={(info) => setToolCalls([...toolCalls, { ...info, id: nextToolCallId++ }])}
        initialServer={queryParams.server}
        initialTool={queryParams.tool}
        autoCall={queryParams.call}
      />
    </>
  );
}


// CallToolPanel renders the unified form with Suspense around ServerSelect
interface CallToolPanelProps {
  serversPromise: Promise<ServerInfo[]>;
  addToolCall: (info: ToolCallInfo) => void;
  initialServer?: string | null;
  initialTool?: string | null;
  autoCall?: boolean;
}
function CallToolPanel({ serversPromise, addToolCall, initialServer, initialTool, autoCall }: CallToolPanelProps) {
  const [selectedServer, setSelectedServer] = useState<ServerInfo | null>(null);
  const [selectedTool, setSelectedTool] = useState("");
  const [inputJson, setInputJson] = useState("{}");
  const [hasAutoCalledRef] = useState({ called: false });

  // Filter out app-only tools, prioritize tools with UIs
  const toolNames = selectedServer
    ? Array.from(selectedServer.tools.values())
        .filter((tool) => isToolVisibleToModel(tool))
        .sort(compareTools)
        .map((tool) => tool.name)
    : [];

  const isValidJson = useMemo(() => {
    try {
      JSON.parse(inputJson);
      return true;
    } catch {
      return false;
    }
  }, [inputJson]);

  const handleServerSelect = (server: ServerInfo, preferredTool?: string) => {
    setSelectedServer(server);
    // Filter out app-only tools, prioritize tools with UIs
    const visibleTools = Array.from(server.tools.values())
      .filter((tool) => isToolVisibleToModel(tool))
      .sort(compareTools);

    // Use preferred tool if it exists and is visible, otherwise first visible tool
    const targetTool = preferredTool && visibleTools.some(t => t.name === preferredTool)
      ? preferredTool
      : visibleTools[0]?.name ?? "";

    setSelectedTool(targetTool);
    // Set input JSON to tool defaults (if any)
    setInputJson(getToolDefaults(server.tools.get(targetTool)));
  };

  const handleToolSelect = (toolName: string) => {
    setSelectedTool(toolName);
    // Set input JSON to tool defaults (if any)
    setInputJson(getToolDefaults(selectedServer?.tools.get(toolName)));
  };

  // Submit with optional override for server/tool (used by auto-call)
  const handleSubmit = (overrideServer?: ServerInfo, overrideTool?: string) => {
    const server = overrideServer ?? selectedServer;
    const tool = overrideTool ?? selectedTool;
    if (!server) return;

    const toolCallInfo = callTool(server, tool, JSON.parse(inputJson));
    addToolCall(toolCallInfo);

    // Update URL for easy refresh/sharing (without triggering navigation)
    const url = new URL(window.location.href);
    url.searchParams.set("server", server.name);
    url.searchParams.set("tool", tool);
    url.searchParams.set("call", "true"); // Auto-call on refresh
    history.replaceState(null, "", url.toString());
  };

  return (
    <div className={styles.callToolPanel}>
      <form onSubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
        <label>
          Server
          <Suspense fallback={<select disabled><option>Loading...</option></select>}>
            <ServerSelect
              serversPromise={serversPromise}
              onSelect={handleServerSelect}
              initialServer={initialServer}
              initialTool={initialTool}
              autoCall={autoCall && !hasAutoCalledRef.called}
              onAutoCall={(server, tool) => {
                hasAutoCalledRef.called = true;
                handleSubmit(server, tool);
              }}
            />
          </Suspense>
        </label>
        <label>
          Tool
          <select
            className={styles.toolSelect}
            value={selectedTool}
            onChange={(e) => handleToolSelect(e.target.value)}
          >
            {selectedServer && toolNames.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </label>
        <label>
          Input
          <textarea
            className={styles.toolInput}
            aria-invalid={!isValidJson}
            value={inputJson}
            onChange={(e) => setInputJson(e.target.value)}
          />
        </label>
        <button type="submit" disabled={!selectedTool || !isValidJson}>
          Call Tool
        </button>
      </form>
    </div>
  );
}


// ServerSelect calls use() and renders the server <select>
interface ServerSelectProps {
  serversPromise: Promise<ServerInfo[]>;
  onSelect: (server: ServerInfo, toolName?: string) => void;
  initialServer?: string | null;
  initialTool?: string | null;
  autoCall?: boolean;
  onAutoCall?: (server: ServerInfo, tool: string) => void;
}
function ServerSelect({ serversPromise, onSelect, initialServer, initialTool, autoCall, onAutoCall }: ServerSelectProps) {
  const servers = use(serversPromise);
  const [hasInitialized, setHasInitialized] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Initialize with the correct server/tool when servers are loaded
  useEffect(() => {
    if (hasInitialized || servers.length === 0) return;

    // Find initial server index if specified
    let idx = 0;
    if (initialServer) {
      const foundIdx = servers.findIndex(s => s.name === initialServer);
      if (foundIdx >= 0) idx = foundIdx;
    }

    const server = servers[idx];
    setSelectedIndex(idx);

    // Find the tool to use
    const visibleTools = Array.from(server.tools.values())
      .filter((tool) => isToolVisibleToModel(tool))
      .sort(compareTools);
    const targetTool = initialTool && visibleTools.some(t => t.name === initialTool)
      ? initialTool
      : visibleTools[0]?.name ?? "";

    onSelect(server, targetTool);
    setHasInitialized(true);

    // Auto-call after initial selection if requested
    if (autoCall && targetTool) {
      onAutoCall?.(server, targetTool);
    }
  }, [servers, hasInitialized, initialServer, initialTool, autoCall, onSelect, onAutoCall]);

  if (servers.length === 0) {
    return <select disabled><option>No servers configured</option></select>;
  }

  return (
    <select
      value={selectedIndex}
      onChange={(e) => {
        const newIndex = Number(e.target.value);
        setSelectedIndex(newIndex);
        onSelect(servers[newIndex]);
      }}
    >
      {servers.map((server, i) => (
        <option key={i} value={i}>{server.name}</option>
      ))}
    </select>
  );
}


interface ToolCallInfoPanelProps {
  toolCallInfo: ToolCallInfo;
  isDestroying?: boolean;
  onRequestClose?: () => void;
  onCloseComplete?: () => void;
}
function ToolCallInfoPanel({ toolCallInfo, isDestroying, onRequestClose, onCloseComplete }: ToolCallInfoPanelProps) {
  const isApp = hasAppHtml(toolCallInfo);

  // For non-app tool calls, close immediately when isDestroying becomes true
  useEffect(() => {
    if (isDestroying && !isApp) {
      onCloseComplete?.();
    }
  }, [isDestroying, isApp, onCloseComplete]);

  const inputJson = JSON.stringify(toolCallInfo.input, null, 2);

  return (
    <div
      className={styles.toolCallInfoPanel}
      style={isDestroying ? { opacity: 0.5, pointerEvents: "none" } : undefined}
    >
      {/* Row 1: Header with server:tool name and close button */}
      <div className={styles.appHeader}>
        <span>{toolCallInfo.serverInfo.name}:<span className={styles.toolName}>{toolCallInfo.tool.name}</span></span>
        {onRequestClose && !isDestroying && (
          <button
            className={styles.closeButton}
            onClick={onRequestClose}
            title="Close"
          >
            ×
          </button>
        )}
      </div>

      {/* Row 2: Tool Input */}
      <CollapsiblePanel icon="📥" label="Tool Input" content={inputJson} />

      {/* Row 3: App iframe (if app) */}
      {isApp && (
        <ErrorBoundary>
          <Suspense fallback="Loading...">
            <AppIFramePanel
              toolCallInfo={toolCallInfo}
              isDestroying={isDestroying}
              onTeardownComplete={onCloseComplete}
            />
          </Suspense>
        </ErrorBoundary>
      )}

      {/* Row 4: Tool Result */}
      <ErrorBoundary>
        <Suspense fallback="Loading result...">
          <ToolResultPanel toolCallInfo={toolCallInfo} />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}


interface CollapsiblePanelProps {
  icon: string;
  label: string;
  content: string;
  badge?: string;
  defaultExpanded?: boolean;
}
function CollapsiblePanel({ icon, label, content, badge, defaultExpanded = false }: CollapsiblePanelProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div
      className={styles.collapsiblePanel}
      onClick={() => setExpanded(!expanded)}
      title={expanded ? "Click to collapse" : "Click to expand"}
    >
      <div className={styles.collapsibleHeader}>
        <span className={styles.collapsibleLabel}>{icon} {label}</span>
        <span className={styles.collapsibleSize}>
          {badge ?? `${content.length} chars`}
        </span>
        <span className={styles.collapsibleToggle}>
          {expanded ? "▼" : "▶"}
        </span>
      </div>
      {expanded ? (
        <pre className={styles.collapsibleFull}>{content}</pre>
      ) : (
        <div className={styles.collapsiblePreview}>
          {content.slice(0, 100)}{content.length > 100 ? "…" : ""}
        </div>
      )}
    </div>
  );
}


// Dev-only: expose live bridges for console-driven testing, e.g.
//   const b = [...__basicHostBridges.values()][0];
//   await b.callTool({ name: "get-current-view", arguments: {} });
declare global {
  interface Window { __basicHostBridges?: Map<number, ReturnType<typeof newAppBridge>> }
}
let nextDebugBridgeId = 0;


interface AppIFramePanelProps {
  toolCallInfo: Required<ToolCallInfo>;
  isDestroying?: boolean;
  onTeardownComplete?: () => void;
}
function AppIFramePanel({ toolCallInfo, isDestroying, onTeardownComplete }: AppIFramePanelProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const appBridgeRef = useRef<ReturnType<typeof newAppBridge> | null>(null);
  const [modelContext, setModelContext] = useState<ModelContext | null>(null);
  const [messages, setMessages] = useState<AppMessage[]>([]);
  const [displayMode, setDisplayMode] = useState<"inline" | "fullscreen">("inline");
  const [bridgeReady, setBridgeReady] = useState(false);
  // null = view did not declare the `tools` capability (panel hidden)
  const [viewTools, setViewTools] = useState<Tool[] | null>(null);
  // Set synchronously on teardown so no view tool calls race `teardownResource`
  const destroyingRef = useRef(false);
  const debugBridgeIdRef = useRef<number | null>(null);

  const refreshViewTools = useCallback(async () => {
    const bridge = appBridgeRef.current;
    if (!bridge || destroyingRef.current) return;
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

  const handleCallViewTool = useCallback((name: string, args: Record<string, unknown>) => {
    const bridge = appBridgeRef.current;
    if (!bridge || destroyingRef.current) {
      return Promise.reject(new Error("App is closing"));
    }
    return callViewTool(bridge, name, args);
  }, []);

  useEffect(() => {
    const iframe = iframeRef.current!;

    // First get CSP and permissions from resource, then load sandbox
    // CSP is set via HTTP headers (tamper-proof), permissions via iframe allow attribute
    toolCallInfo.appResourcePromise.then(({ csp, permissions }) => {
      loadSandboxProxy(iframe, csp, permissions).then((firstTime) => {
        // The `firstTime` check guards against React Strict Mode's double
        // invocation (mount → unmount → remount simulation in development).
        // Outside of Strict Mode, this `useEffect` runs only once per
        // `toolCallInfo`.
        if (firstTime) {
          const appBridge = newAppBridge(toolCallInfo.serverInfo, iframe, {
            onContextUpdate: setModelContext,
            onMessage: (msg) => setMessages((prev) => [...prev, msg]),
            onDisplayModeChange: setDisplayMode,
            onViewToolsChanged: refreshViewTools,
          }, {
            // Provide container dimensions - maxHeight for flexible sizing
            containerDimensions: { maxHeight: 6000 },
            displayMode: "inline",
          });
          appBridgeRef.current = appBridge;
          if (import.meta.env.DEV) {
            const id = nextDebugBridgeId++;
            debugBridgeIdRef.current = id;
            (window.__basicHostBridges ??= new Map()).set(id, appBridge);
          }
          initializeApp(iframe, appBridge, toolCallInfo).then(() => {
            setBridgeReady(true);
            refreshViewTools();
          });
        }
      });
    });

  }, [toolCallInfo, refreshViewTools]);

  // Graceful teardown: wait for guest to respond before unmounting
  // This follows the spec: "Host SHOULD wait for a response before tearing
  // down the resource (to prevent data loss)."
  useEffect(() => {
    if (!isDestroying) return;
    destroyingRef.current = true;
    if (debugBridgeIdRef.current !== null) {
      window.__basicHostBridges?.delete(debugBridgeIdRef.current);
      debugBridgeIdRef.current = null;
    }

    if (!appBridgeRef.current) {
      // Bridge not ready yet (e.g., user closed before iframe loaded)
      onTeardownComplete?.();
      return;
    }

    log.info("Sending teardown notification to MCP App");
    appBridgeRef.current.teardownResource({})
      .catch((err) => {
        log.warn("Teardown request failed (app may have already closed):", err);
      })
      .finally(() => {
        onTeardownComplete?.();
      });
  }, [isDestroying, onTeardownComplete]);

  // Format content blocks - handle text, images, resources, etc.
  const formatContentBlock = (c: { type: string; [key: string]: unknown }) => {
    switch (c.type) {
      case "text":
        return (c as { type: "text"; text: string }).text;
      case "image":
        return `<image: ${(c as { mimeType?: string }).mimeType ?? "unknown"}>`;
      case "audio":
        return `<audio: ${(c as { mimeType?: string }).mimeType ?? "unknown"}>`;
      case "resource":
        return `<resource: ${(c as { resource?: { uri?: string } }).resource?.uri ?? "unknown"}>`;
      default:
        return `<${c.type}>`;
    }
  };

  // Format context for display
  const contextText = modelContext?.content?.map(formatContentBlock).join("\n") ?? "";
  const contextJson = modelContext?.structuredContent
    ? JSON.stringify(modelContext.structuredContent, null, 2)
    : "";
  const fullContext = [contextText, contextJson].filter(Boolean).join("\n\n");

  // Format messages
  const formatMessage = (m: AppMessage) => {
    const content = m.content.map(formatContentBlock).join("\n");
    return `[${m.role}] ${content}`;
  };
  const messagesText = messages.map(formatMessage).join("\n\n");

  const panelClassName = displayMode === "fullscreen"
    ? `${styles.appIframePanel} ${styles.fullscreen}`
    : styles.appIframePanel;

  return (
    <div className={panelClassName}>
      <iframe ref={iframeRef} />
      {bridgeReady && viewTools !== null && (
        <ViewToolsPanel
          tools={viewTools}
          disabled={!!isDestroying}
          onCall={handleCallViewTool}
        />
      )}
      {messages.length > 0 && (
        <CollapsiblePanel
          icon="💬"
          label="Messages"
          content={messagesText}
          badge={`${messages.length} message${messages.length > 1 ? "s" : ""}`}
        />
      )}
      {modelContext && (
        <CollapsiblePanel icon="📋" label="Model Context" content={fullContext} />
      )}
    </div>
  );
}


interface ViewToolCallEntry {
  id: number;
  toolName: string;
  status: "pending" | "ok" | "isError" | "error";
  content: string;
}

interface ViewToolsPanelProps {
  tools: Tool[];
  disabled: boolean;
  onCall: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
}
/**
 * Lists and calls tools the view registered via `app.registerTool()`.
 * A real host would expose these to the model; basic-host lets a human call them.
 */
function ViewToolsPanel({ tools, disabled, onCall }: ViewToolsPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [selectedTool, setSelectedTool] = useState("");
  const [inputJson, setInputJson] = useState("{}");
  const [inFlight, setInFlight] = useState(false);
  const [results, setResults] = useState<ViewToolCallEntry[]>([]);
  const nextResultIdRef = useRef(0);

  const tool = tools.find((t) => t.name === selectedTool);

  // Keep selection valid as the view's tool list changes
  useEffect(() => {
    if (tools.some((t) => t.name === selectedTool)) return;
    const first = tools[0];
    setSelectedTool(first?.name ?? "");
    setInputJson(getToolDefaults(first));
  }, [tools, selectedTool]);

  const isValidJson = useMemo(() => {
    try {
      JSON.parse(inputJson);
      return true;
    } catch {
      return false;
    }
  }, [inputJson]);

  const handleToolSelect = (name: string) => {
    setSelectedTool(name);
    setInputJson(getToolDefaults(tools.find((t) => t.name === name)));
  };

  const handleSubmit = async () => {
    const id = nextResultIdRef.current++;
    const toolName = selectedTool;
    const update = (entry: Partial<ViewToolCallEntry>) =>
      setResults((prev) => prev.map((r) => (r.id === id ? { ...r, ...entry } : r)));

    setResults((prev) => [{ id, toolName, status: "pending", content: "" }, ...prev]);
    setInFlight(true);
    try {
      const result = await onCall(toolName, JSON.parse(inputJson));
      update({ status: result.isError ? "isError" : "ok", content: JSON.stringify(result, null, 2) });
    } catch (e) {
      update({ status: "error", content: e instanceof Error ? e.message : String(e) });
    } finally {
      setInFlight(false);
    }
  };

  return (
    <div className={styles.viewToolsPanel}>
      <button
        type="button"
        className={styles.viewToolsHeader}
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <span className={styles.collapsibleLabel}>🧩 View Tools ({tools.length})</span>
        <span className={styles.collapsibleToggle}>{expanded ? "▼" : "▶"}</span>
      </button>
      {expanded && (tools.length === 0 ? (
        <p className={styles.viewToolsEmpty}>View declares tools capability but registered none.</p>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
          <label>
            View Tool
            <select
              className={styles.toolSelect}
              value={selectedTool}
              onChange={(e) => handleToolSelect(e.target.value)}
            >
              {tools.map((t) => (
                <option key={t.name} value={t.name} title={t.description}>
                  {t.title ?? t.name}{t.title ? ` (${t.name})` : ""}
                </option>
              ))}
            </select>
            {tool?.description && <span className={styles.viewToolDescription}>{tool.description}</span>}
          </label>
          {tool && (
            <CollapsiblePanel
              icon="📐"
              label="Input Schema"
              content={JSON.stringify(tool.inputSchema, null, 2)}
            />
          )}
          <label>
            Arguments
            <textarea
              className={styles.toolInput}
              aria-invalid={!isValidJson}
              value={inputJson}
              onChange={(e) => setInputJson(e.target.value)}
            />
          </label>
          <button type="submit" disabled={disabled || !tool || !isValidJson || inFlight}>
            Call View Tool
          </button>
          {results.map((r) => (
            <CollapsiblePanel
              key={r.id}
              icon="📤"
              label={r.toolName}
              badge={r.status}
              content={r.content}
              defaultExpanded
            />
          ))}
        </form>
      ))}
    </div>
  );
}


interface ToolResultPanelProps {
  toolCallInfo: ToolCallInfo;
}
function ToolResultPanel({ toolCallInfo }: ToolResultPanelProps) {
  const result = use(toolCallInfo.resultPromise);
  const resultJson = JSON.stringify(result, null, 2);
  return <CollapsiblePanel icon="📤" label="Tool Result" content={resultJson} />;
}


interface ErrorBoundaryProps {
  children: ReactNode;
}
interface ErrorBoundaryState {
  hasError: boolean;
  error: unknown;
}
class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: undefined };

  // Called during render phase - must be pure (no side effects)
  // Note: error is `unknown` because JS allows throwing any value
  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { hasError: true, error };
  }

  // Called during commit phase - can have side effects (logging, etc.)
  componentDidCatch(error: unknown, errorInfo: ErrorInfo): void {
    log.error("Caught:", error, errorInfo.componentStack);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      const { error } = this.state;
      const message = error instanceof Error ? error.message : String(error);
      return <div className={styles.error}><strong>ERROR:</strong> {message}</div>;
    }
    return this.props.children;
  }
}


async function connectToAllServers(): Promise<ServerInfo[]> {
  const serverUrlsResponse = await fetch("/api/servers");
  const serverUrls = (await serverUrlsResponse.json()) as string[];

  // Use allSettled to be resilient to individual server failures
  const results = await Promise.allSettled(
    serverUrls.map((url) => connectToServer(new URL(url)))
  );

  const servers: ServerInfo[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled") {
      servers.push(result.value);
    } else {
      console.warn(`[HOST] Failed to connect to ${serverUrls[i]}:`, result.reason);
    }
  }

  if (servers.length === 0 && serverUrls.length > 0) {
    throw new Error(`Failed to connect to any servers (${serverUrls.length} attempted)`);
  }

  return servers;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <Host serversPromise={connectToAllServers()} />
    </ErrorBoundary>
  </StrictMode>,
);
