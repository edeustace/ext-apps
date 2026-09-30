import { test, expect, type Page } from "@playwright/test";

/**
 * Tests for basic-host's View Tools panel: listing and calling tools that an
 * MCP App registers inside its iframe via `app.registerTool()`.
 *
 * map-server registers `navigate-to` and `get-current-view` in its view.
 */

const MAP_SERVER = { name: "CesiumJS Map Server", dir: "map-server" };
const NO_VIEW_TOOLS_SERVER = {
  name: "Basic MCP App Server (Vanilla JS)",
  dir: "basic-server-vanillajs",
};

const EXAMPLE_FILTER = process.env.EXAMPLE;

// CesiumJS loads from a CDN; the viewer may not exist yet when the panel first
// appears, so view tool calls get the same allowance as SLOW_SERVERS in
// servers.spec.ts.
const MAP_READY_TIMEOUT = 15000;

const LONDON = { west: -0.5, south: 51.3, east: 0.3, north: 51.7 };

async function loadServer(page: Page, serverName: string) {
  await page.goto("/?theme=hide");
  await expect(page.locator("select").first()).toBeEnabled({ timeout: 30000 });
  await page.locator("select").first().selectOption({ label: serverName });
  await page.click('button:has-text("Call Tool")');
  const outerFrame = page.frameLocator("iframe").first();
  await expect(outerFrame.locator("iframe")).toBeVisible({ timeout: 30000 });
}

function viewToolsPanel(page: Page) {
  return page.locator('[class*="viewToolsPanel"]');
}

async function expandViewTools(page: Page) {
  const panel = viewToolsPanel(page);
  await expect(panel).toBeVisible({ timeout: 30000 });
  await panel.getByRole("button", { name: /View Tools/ }).click();
  return panel;
}

/** Newest result panel for a view tool call. */
function latestResult(page: Page) {
  return viewToolsPanel(page)
    .locator('[class*="collapsiblePanel"]')
    .filter({ hasText: "📤" })
    .first();
}

async function callViewTool(
  page: Page,
  name: string,
  args: Record<string, unknown>,
) {
  const panel = viewToolsPanel(page);
  await panel.locator("select").selectOption(name);
  await panel.locator("textarea").fill(JSON.stringify(args));
  const button = panel.getByRole("button", { name: "Call View Tool" });
  await expect(button).toBeEnabled();
  await button.click();
  const result = latestResult(page);
  await expect(result).not.toContainText("pending");
  return result;
}

/** Status badge and parsed JSON of the newest result. */
async function readLatestResult(page: Page) {
  const result = latestResult(page);
  const badge = await result.locator('[class*="collapsibleSize"]').innerText();
  const text = await result.locator("pre").innerText();
  return { badge, text };
}

/**
 * Call a view tool, retrying while the map viewer is still initializing
 * (the view returns `isError: true` with "Viewer not initialized").
 */
async function callMapToolWhenReady(
  page: Page,
  name: string,
  args: Record<string, unknown>,
) {
  let last = { badge: "", text: "" };
  await expect(async () => {
    await callViewTool(page, name, args);
    last = await readLatestResult(page);
    expect(last.text).not.toContain("Viewer not initialized");
  }).toPass({ timeout: MAP_READY_TIMEOUT });
  return last;
}

test.describe("View Tools - map-server", () => {
  test.skip(
    () => !!EXAMPLE_FILTER && EXAMPLE_FILTER !== MAP_SERVER.dir,
    "Skipped: map-server not in EXAMPLE filter",
  );

  test("lists view tools", async ({ page }) => {
    await loadServer(page, MAP_SERVER.name);
    const panel = await expandViewTools(page);

    await expect(panel).toContainText("View Tools (2)");
    const values = await panel
      .locator("select option")
      .evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value));
    expect(values.sort()).toEqual(["get-current-view", "navigate-to"]);
  });

  test("calls get-current-view", async ({ page }) => {
    await loadServer(page, MAP_SERVER.name);
    await expandViewTools(page);

    const { badge, text } = await callMapToolWhenReady(
      page,
      "get-current-view",
      {},
    );
    expect(badge).toBe("ok");
    expect(text).toContain("camera");
  });

  test("calls navigate-to then get-current-view reflects it", async ({
    page,
  }) => {
    await loadServer(page, MAP_SERVER.name);
    await expandViewTools(page);

    const nav = await callMapToolWhenReady(page, "navigate-to", {
      ...LONDON,
      duration: 0.5,
      label: "London",
    });
    expect(nav.badge).toBe("ok");
    expect(nav.text).toContain("Navigated to:");
    expect(nav.text).toContain("(London)");

    const view = await callMapToolWhenReady(page, "get-current-view", {});
    expect(view.badge).toBe("ok");
    const { bbox } = JSON.parse(view.text).structuredContent as {
      bbox: typeof LONDON | null;
    };
    expect(bbox).not.toBeNull();
    // Cesium pads the view to fit the viewport, so only check overlap.
    expect(bbox!.west).toBeLessThan(LONDON.east);
    expect(bbox!.east).toBeGreaterThan(LONDON.west);
    expect(bbox!.south).toBeLessThan(LONDON.north);
    expect(bbox!.north).toBeGreaterThan(LONDON.south);
  });

  test("invalid arguments show an error result", async ({ page }) => {
    await loadServer(page, MAP_SERVER.name);
    await expandViewTools(page);

    await callViewTool(page, "navigate-to", {});
    const { badge } = await readLatestResult(page);
    expect(["error", "isError"]).toContain(badge);

    // Host is still usable afterwards
    await expect(
      viewToolsPanel(page).getByRole("button", { name: "Call View Tool" }),
    ).toBeEnabled();
  });
});

test.describe("View Tools - app without view tools", () => {
  test.skip(
    () => !!EXAMPLE_FILTER && EXAMPLE_FILTER !== NO_VIEW_TOOLS_SERVER.dir,
    "Skipped: basic-server-vanillajs not in EXAMPLE filter",
  );

  test("does not render the View Tools panel", async ({ page }) => {
    await loadServer(page, NO_VIEW_TOOLS_SERVER.name);
    // Give initialization time to complete before asserting absence
    await page.waitForTimeout(1000);
    await expect(viewToolsPanel(page)).toHaveCount(0);
  });
});
