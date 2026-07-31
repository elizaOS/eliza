/**
 * Exercises the user-visible data states and install interaction with a
 * contract-valid snapshot rather than bypassing the production validator.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { snapshotFixture } from "./fixtures";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mockFetch(response: Response) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
}

describe("App", () => {
  it("renders validated queue, score breakdown, and model provenance", async () => {
    mockFetch(
      new Response(JSON.stringify(snapshotFixture()), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    );

    render(<App />);

    expect(
      screen.getByRole("heading", {
        name: /your agent can finish elizaOS work/i,
      }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("Launch the eliza.army contribution protocol"),
    ).toBeInTheDocument();
    expect(screen.getByText("7-day proof review")).toBeInTheDocument();
    expect(
      screen.getByText(
        /complete verification coverage 1 merged PRs \+ 1 closed issues/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("@finish-line")).toBeInTheDocument();
    expect(screen.getByText("openai/gpt-5")).toBeInTheDocument();
    expect(screen.getByText("24")).toBeInTheDocument();
    expect(screen.getByText("self-reported")).toBeInTheDocument();
  });

  it("switches install clients and reports successful copy", async () => {
    mockFetch(
      new Response(JSON.stringify(snapshotFixture()), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<App />);
    fireEvent.click(screen.getByRole("tab", { name: "Codex" }));
    expect(screen.getByText(/SKILLS_ROOT=/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    const command = writeText.mock.calls[0][0];
    expect(command).toContain("downloads/contribute-to-eliza.skill");
    expect(command).toContain("set -eu");
    expect(command).toContain("trap cleanup EXIT");
    expect(command).toContain("trap 'exit 1' HUP INT TERM");
    expect(command).toContain('$2 == "contribute-to-eliza.skill"');
    expect(command).toContain(`test "\${#EXPECTED}" -eq 64`);
    expect(command).toContain("*[!0-9A-Fa-f]*");
    expect(command).toContain("sha256sum");
    expect(command).toContain("shasum -a 256");
    expect(command).toContain("--max-filesize 10485760");
    expect(command).toContain('unzip -tq "$ARCHIVE"');
    expect(command).toContain('unzip -Z1 "$ARCHIVE"');
    expect(command).toContain('index($0, "contribute-to-eliza/") != 1');
    expect(command).toContain(
      'find "$STAGE_ROOT" ! -type f ! -type d -print -quit',
    );
    expect(command).toContain("Refusing to overwrite existing skill");
    expect(command).toContain('test -f "$TARGET/PROVENANCE.json"');
    expect(command.indexOf('test "$ACTUAL" = "$EXPECTED"')).toBeLessThan(
      command.indexOf('mkdir -p "$SKILLS_ROOT"'),
    );
    expect(await screen.findByRole("button", { name: "Copied" })).toBeVisible();
  });

  it("renders an observable error and retries instead of fabricating empty data", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(snapshotFixture()), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
      );

    render(<App />);

    const alerts = await screen.findAllByRole("alert");
    expect(alerts[0]).toHaveTextContent("did not load");
    expect(alerts[0]).toHaveTextContent("No empty result has been substituted");
    fireEvent.click(screen.getAllByRole("button", { name: /retry/i })[0]);

    expect(
      await screen.findByText("Launch the eliza.army contribution protocol"),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a structurally invalid snapshot at the browser boundary", async () => {
    mockFetch(
      new Response(
        JSON.stringify({
          ...snapshotFixture(),
          repository: "another/repository",
        }),
        { status: 200 },
      ),
    );

    render(<App />);

    const alerts = await screen.findAllByRole("alert");
    expect(alerts[0]).toHaveTextContent(
      "snapshot.repository must be elizaOS/eliza",
    );
    expect(screen.queryByText("@finish-line")).not.toBeInTheDocument();
  });
});
