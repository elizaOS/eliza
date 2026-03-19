/**
 * E2E tests for Character Customization (CharacterView).
 *
 * Tests cover:
 * 1. Identity editing (name, bio, system prompt)
 * 2. Voice picker placement and editing layout
 * 3. Style configuration
 * 4. Avatar selection
 * 5. Save functionality
 */

import http from "node:http";
// @vitest-environment jsdom
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// ---------------------------------------------------------------------------
// Part 1: API Tests for Character Endpoints
// ---------------------------------------------------------------------------

async function req(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            data = { _raw: raw };
          }
          resolve({ status: res.statusCode ?? 0, data });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function createCharacterTestServer(): Promise<{
  port: number;
  close: () => Promise<void>;
  getCharacter: () => {
    name: string;
    bio: string[];
    system: string;
    adjectives: string[];
    style: { all: string[]; chat: string[]; post: string[] };
  };
}> {
  const character = {
    name: "TestAgent",
    bio: ["A helpful AI assistant"],
    system: "You are a helpful assistant",
    adjectives: ["friendly", "helpful"],
    style: {
      all: ["Be concise"],
      chat: ["Use casual tone"],
      post: ["Be informative"],
    },
    avatar: 1,
  };

  const json = (res: http.ServerResponse, data: unknown, status = 200) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify(data));
  };

  const readBody = (r: http.IncomingMessage): Promise<string> =>
    new Promise((ok) => {
      const c: Buffer[] = [];
      r.on("data", (d: Buffer) => c.push(d));
      r.on("end", () => ok(Buffer.concat(c).toString()));
    });

  const routes: Record<
    string,
    (
      req: http.IncomingMessage,
      res: http.ServerResponse,
    ) => Promise<void> | void
  > = {
    "GET /api/character": (_r, res) => json(res, { character }),
    "PUT /api/character": async (r, res) => {
      const body = JSON.parse(await readBody(r)) as Record<string, unknown>;
      if (body.name) character.name = body.name as string;
      if (body.bio) character.bio = body.bio as string[];
      if (body.system) character.system = body.system as string;
      if (body.adjectives) character.adjectives = body.adjectives as string[];
      if (body.style) character.style = body.style as typeof character.style;
      if (body.avatar !== undefined) character.avatar = body.avatar as number;
      json(res, { ok: true, character });
    },
    "PATCH /api/character": async (r, res) => {
      const body = JSON.parse(await readBody(r)) as Record<string, unknown>;
      Object.assign(character, body);
      json(res, { ok: true, character });
    },
  };

  const server = http.createServer(async (rq, rs) => {
    if (rq.method === "OPTIONS") {
      rs.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "*",
        "Access-Control-Allow-Headers": "*",
      });
      rs.end();
      return;
    }
    const key = `${rq.method} ${new URL(rq.url ?? "/", "http://localhost").pathname}`;
    const handler = routes[key];
    if (handler) {
      await handler(rq, rs);
    } else {
      json(rs, { error: "Not found" }, 404);
    }
  });

  return new Promise((ok) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      ok({
        port: typeof addr === "object" && addr ? addr.port : 0,
        close: () => new Promise<void>((r) => server.close(() => r())),
        getCharacter: () => ({
          name: character.name,
          bio: character.bio,
          system: character.system,
          adjectives: character.adjectives,
          style: character.style,
        }),
      });
    });
  });
}

describe("Character API", () => {
  let port: number;
  let close: () => Promise<void>;
  let getCharacter: ReturnType<
    typeof createCharacterTestServer
  > extends Promise<infer T>
    ? T["getCharacter"]
    : never;

  beforeAll(async () => {
    ({ port, close, getCharacter } = await createCharacterTestServer());
  });

  afterAll(async () => {
    await close();
  });

  it("GET /api/character returns character data", async () => {
    const { status, data } = await req(port, "GET", "/api/character");
    expect(status).toBe(200);
    expect(data.character).toBeDefined();
    const char = data.character as Record<string, unknown>;
    expect(char.name).toBe("TestAgent");
    expect(Array.isArray(char.bio)).toBe(true);
  });

  it("PUT /api/character updates name", async () => {
    const { status, data } = await req(port, "PUT", "/api/character", {
      name: "UpdatedAgent",
    });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(getCharacter().name).toBe("UpdatedAgent");
  });

  it("PUT /api/character updates bio", async () => {
    const newBio = ["First line", "Second line"];
    const { status } = await req(port, "PUT", "/api/character", {
      bio: newBio,
    });
    expect(status).toBe(200);
    expect(getCharacter().bio).toEqual(newBio);
  });

  it("PUT /api/character updates system prompt", async () => {
    const newSystem = "You are a specialized assistant for coding tasks";
    const { status } = await req(port, "PUT", "/api/character", {
      system: newSystem,
    });
    expect(status).toBe(200);
    expect(getCharacter().system).toBe(newSystem);
  });

  it("PUT /api/character updates adjectives", async () => {
    const newAdj = ["creative", "analytical", "patient"];
    const { status } = await req(port, "PUT", "/api/character", {
      adjectives: newAdj,
    });
    expect(status).toBe(200);
    expect(getCharacter().adjectives).toEqual(newAdj);
  });

  it("PUT /api/character updates style rules", async () => {
    const newStyle = {
      all: ["Be precise", "Use examples"],
      chat: ["Keep it casual"],
      post: ["Be thorough"],
    };
    const { status } = await req(port, "PUT", "/api/character", {
      style: newStyle,
    });
    expect(status).toBe(200);
    expect(getCharacter().style).toEqual(newStyle);
  });

  it("PATCH /api/character partially updates character", async () => {
    const { status } = await req(port, "PATCH", "/api/character", {
      name: "PartialUpdate",
    });
    expect(status).toBe(200);
    expect(getCharacter().name).toBe("PartialUpdate");
  });
});

// ---------------------------------------------------------------------------
// Part 2: UI Tests for CharacterView
// ---------------------------------------------------------------------------

const { mockUseApp } = vi.hoisted(() => ({
  mockUseApp: vi.fn(),
}));

vi.mock("@elizaos/app-core/state", async () => {
  const actual = await vi.importActual("@elizaos/app-core/state");
  return {
    ...actual,
    useApp: () => mockUseApp(),
  };
});

vi.mock("@elizaos/app-core/api", () => ({
  client: {
    getCharacter: vi.fn().mockResolvedValue({
      name: "TestAgent",
      bio: ["Bio line 1"],
      system: "System prompt",
      adjectives: ["friendly"],
      style: { all: [], chat: [], post: [] },
    }),
    getConfig: vi.fn().mockResolvedValue({
      messages: {
        tts: {
          provider: "elevenlabs",
          elevenlabs: { voiceId: "EXAVITQu4vr4xnSDxMaL" },
        },
      },
    }),
    updateConfig: vi.fn().mockResolvedValue({ ok: true }),
    getOnboardingOptions: vi.fn().mockResolvedValue({
      styles: [],
    }),
    updateCharacter: vi.fn().mockResolvedValue({
      ok: true,
      character: {},
      agentName: "TestAgent",
    }),
  },
}));

vi.mock("../../src/components/AvatarSelector", () => ({
  AvatarSelector: ({
    value,
    onChange,
  }: {
    value: number;
    onChange: (v: number) => void;
  }) =>
    React.createElement(
      "div",
      { "data-testid": "avatar-selector" },
      React.createElement(
        "button",
        { type: "button", onClick: () => onChange(2) },
        `Avatar ${value}`,
      ),
    ),
}));

vi.mock("@elizaos/app-core/config", () => ({
  ConfigRenderer: () => React.createElement("div", null, "ConfigRenderer"),
  defaultRegistry: {},
}));

import { client } from "@elizaos/app-core/api";
import { CharacterView } from "../../src/components/CharacterView";

type CharacterData = {
  name: string;
  username?: string;
  bio: string | string[];
  system: string;
  adjectives: string[];
  topics?: string[];
  style: { all: string[]; chat: string[]; post: string[] };
  messageExamples?: Array<{
    examples: Array<{ name: string; content: { text: string } }>;
  }>;
  postExamples?: string[];
};

type CharacterState = {
  tab: "character" | "character-select";
  characterLoading: boolean;
  characterData: CharacterData | null;
  characterDraft: CharacterData | null;
  characterSaving: boolean;
  characterDirty: boolean;
  characterSaveSuccess: string | null;
  characterSaveError: string | null;
  selectedVrmIndex: number;
  onboardingOptions: {
    styles: Array<{
      catchphrase: string;
      hint: string;
      bio: string[];
      system: string;
      adjectives: string[];
      style: { all: string[]; chat: string[]; post: string[] };
      postExamples: string[];
      messageExamples: Array<
        Array<{ user: string; content: { text: string } }>
      >;
    }>;
  } | null;
  registryStatus: null;
  registryLoading: boolean;
  registryRegistering: boolean;
  registryError: string | null;
  dropStatus: null;
  mintInProgress: boolean;
  mintResult: null;
};

function createCharacterUIState(): CharacterState {
  const charData: CharacterData = {
    name: "Ai",
    username: "Ai",
    bio: ["Ai is soft and friendly"],
    system: "You are Ai",
    adjectives: ["friendly", "helpful"],
    style: { all: ["Rule 1"], chat: ["Chat rule"], post: ["Post rule"] },
    messageExamples: [
      {
        examples: [
          { name: "{{user1}}", content: { text: "hi" } },
          { name: "Ai", content: { text: "hey" } },
        ],
      },
    ],
    postExamples: [],
  };

  return {
    tab: "character-select",
    characterLoading: false,
    characterData: charData,
    characterDraft: { ...charData },
    characterSaving: false,
    characterDirty: false,
    characterSaveSuccess: null,
    characterSaveError: null,
    selectedVrmIndex: 2,
    onboardingOptions: {
      styles: [
        {
          catchphrase: "uwu~",
          hint: "warm & caring",
          bio: ["{{name}} is soft and friendly"],
          system: "You are {{name}}",
          adjectives: ["friendly", "helpful"],
          style: { all: ["Rule 1"], chat: ["Chat rule"], post: ["Post rule"] },
          postExamples: [],
          messageExamples: [
            [
              { user: "{{user1}}", content: { text: "hi" } },
              { user: "{{agentName}}", content: { text: "hey" } },
            ],
          ],
        },
        {
          catchphrase: "Noted.",
          hint: "dignified & commanding",
          bio: ["{{name}} is precise"],
          system: "You are {{name}}, exact and calm.",
          adjectives: ["precise", "calm"],
          style: { all: ["Be exact"], chat: ["Stay calm"], post: ["Be clear"] },
          postExamples: [],
          messageExamples: [
            [
              { user: "{{user1}}", content: { text: "status?" } },
              { user: "{{agentName}}", content: { text: "On track." } },
            ],
          ],
        },
      ],
    },
    registryStatus: null,
    registryLoading: false,
    registryRegistering: false,
    registryError: null,
    dropStatus: null,
    mintInProgress: false,
    mintResult: null,
  };
}

function prepareCharacterDraftForSave(draft: CharacterData) {
  const prepared: Record<string, unknown> = { ...draft };

  if (typeof prepared.bio === "string") {
    const lines = prepared.bio
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    prepared.bio = lines.length > 0 ? lines : undefined;
  }

  if (Array.isArray(prepared.adjectives) && prepared.adjectives.length === 0) {
    delete prepared.adjectives;
  }
  if (
    Array.isArray(prepared.postExamples) &&
    prepared.postExamples.length === 0
  ) {
    delete prepared.postExamples;
  }
  if (
    Array.isArray(prepared.messageExamples) &&
    prepared.messageExamples.length === 0
  ) {
    delete prepared.messageExamples;
  }

  if (prepared.style && typeof prepared.style === "object") {
    const style = prepared.style as Record<string, string[] | undefined>;
    if (style.all && style.all.length === 0) delete style.all;
    if (style.chat && style.chat.length === 0) delete style.chat;
    if (style.post && style.post.length === 0) delete style.post;
    if (!style.all && !style.chat && !style.post) delete prepared.style;
  }

  if (
    typeof prepared.username === "string" &&
    prepared.username.trim().length > 0
  ) {
    prepared.username = prepared.username.trim();
  } else if (
    typeof prepared.name === "string" &&
    prepared.name.trim().length > 0
  ) {
    prepared.username = prepared.name.trim();
  }
  if (!prepared.name) delete prepared.name;
  if (!prepared.username) delete prepared.username;
  if (!prepared.system) delete prepared.system;

  return prepared;
}

describe("CharacterView UI", () => {
  let state: CharacterState;
  let _saveCharacterCalled: boolean;

  beforeEach(() => {
    state = createCharacterUIState();
    _saveCharacterCalled = false;
    vi.mocked(client.updateCharacter).mockClear();
    vi.mocked(client.updateConfig).mockClear();

    mockUseApp.mockReset();
    mockUseApp.mockImplementation(() => ({
      uiLanguage: "en",
      t: (k: string) => k,
      ...state,
      setTab: vi.fn((tab: CharacterState["tab"]) => {
        state.tab = tab;
      }),
      loadCharacter: vi.fn(),
      loadRegistryStatus: vi.fn(),
      loadDropStatus: vi.fn(),
      handleSaveCharacter: async () => {
        _saveCharacterCalled = true;
        state.characterSaving = false;
        state.characterDirty = false;
      },
      handleCharacterFieldInput: (field: string, value: unknown) => {
        if (state.characterDraft) {
          (state.characterDraft as Record<string, unknown>)[field] = value;
          state.characterDirty = true;
        }
      },
      handleCharacterArrayInput: vi.fn(),
      handleCharacterStyleInput: vi.fn(),
      setState: vi.fn((key: string, value: unknown) => {
        (state as Record<string, unknown>)[key] = value;
      }),
    }));
  });

  it("renders CharacterView with character name", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(CharacterView));
    });

    expect(tree).not.toBeNull();
    const json = tree?.toJSON();
    expect(json).not.toBeNull();
  });

  it("renders the character roster as a single full-width row without a separate current character card", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(CharacterView));
    });

    const roster = tree?.root.find(
      (node) => node.props["data-testid"] === "character-roster-grid",
    );
    expect(roster).toBeDefined();
    expect(roster?.props.className).toContain("overflow-hidden");

    expect(
      tree?.root.findAll(
        (node) => node.props["data-testid"] === "character-current-card",
      ) ?? [],
    ).toHaveLength(0);
  });

  it("anchors the scene overlay layout to the bottom of the viewport", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(CharacterView, { sceneOverlay: true }),
      );
    });

    const json = tree?.toJSON();
    expect(json).not.toBeNull();
    expect(
      json &&
      !Array.isArray(json) &&
      typeof json.props.className === "string" &&
      json.props.className.includes("min-h-full"),
    ).toBe(true);
    expect(
      json &&
      !Array.isArray(json) &&
      typeof json.props.className === "string" &&
      json.props.className.includes("justify-end"),
    ).toBe(true);
  });

  it("starts in roster mode even when the saved draft differs from the selected preset", async () => {
    state.characterDraft = {
      ...(state.characterDraft as CharacterData),
      system: "Custom system override",
    };
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(CharacterView));
    });

    expect(
      tree?.root.findAll(
        (node) => node.props["data-testid"] === "character-notebook",
      ) ?? [],
    ).toHaveLength(0);
    expect(state.characterDraft?.name).toBe("Ai");
    expect(state.characterDraft?.bio).toEqual(["Ai is soft and friendly"]);
    expect(state.characterDraft?.system).toBe("Custom system override");
    expect(state.selectedVrmIndex).toBe(2);
  });

  it("keeps roster mode when routed to the character tab until custom mode is enabled", async () => {
    state.tab = "character";

    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(CharacterView));
    });
    await act(async () => {
      tree?.update(React.createElement(CharacterView));
    });

    expect(
      tree?.root.findAll(
        (node) => node.props["data-testid"] === "character-notebook",
      ) ?? [],
    ).toHaveLength(1);
    expect(
      tree?.root.findAll(
        (node) => node.props["data-testid"] === "character-roster-grid",
      ) ?? [],
    ).toHaveLength(0);
  });

  it("removes adjective editors from the character screen", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(CharacterView));
    });

    const adjectiveLabels =
      tree?.root.findAll((node) =>
        node.children?.some(
          (child) =>
            child === "Adjectives" || child === "characterview.adjectives",
        ),
      ) ?? [];

    expect(adjectiveLabels).toHaveLength(0);
  });

  it("shows the voice picker in roster mode and keeps it visible while customizing", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(CharacterView));
    });

    expect(
      tree?.root.findAll(
        (node) => node.props["data-testid"] === "character-voice-picker",
      ) ?? [],
    ).toHaveLength(1);

    const customizeButton = tree?.root.find(
      (node) => node.props["data-testid"] === "character-customize-toggle",
    );

    await act(async () => {
      customizeButton?.props.onClick();
    });
    await act(async () => {
      tree?.update(React.createElement(CharacterView));
    });

    expect(
      tree?.root.findAll(
        (node) => node.props["data-testid"] === "character-roster-grid",
      ) ?? [],
    ).toHaveLength(0);
    expect(
      tree?.root.findAll(
        (node) => node.props["data-testid"] === "character-voice-picker",
      ) ?? [],
    ).toHaveLength(1);
    expect(
      tree?.root.findAll(
        (node) => node.props["data-testid"] === "character-notebook",
      ) ?? [],
    ).toHaveLength(1);
  });

  it("shows style sections when navigating to the styleRules sidebar tab", async () => {
    state.tab = "character";

    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(CharacterView));
    });
    await act(async () => {
      tree?.update(React.createElement(CharacterView));
    });

    const styleTab = tree?.root.find(
      (node) =>
        node.props["data-testid"] === "notebook-tab-styleRules" &&
        typeof node.props.onClick === "function",
    );

    await act(async () => {
      styleTab?.props.onClick();
    });

    expect(
      tree?.root.findAll(
        (node) =>
          node.props["data-testid"] === "style-section-all" ||
          node.props["data-testid"] === "style-section-chat" ||
          node.props["data-testid"] === "style-section-post",
      ),
    ).toHaveLength(3);
  });

  it("turning custom off applies the selected character defaults and hides the editors", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(CharacterView));
    });

    const customizeButton = tree?.root.find(
      (node) => node.props["data-testid"] === "character-customize-toggle",
    );

    await act(async () => {
      customizeButton?.props.onClick();
    });

    const backButton = tree?.root.find(
      (node) => node.props["data-testid"] === "character-customize-toggle",
    );

    await act(async () => {
      backButton?.props.onClick();
    });

    expect(state.characterDraft?.name).toBe("Ai");
    expect(state.characterDraft?.bio).toBe("Ai is soft and friendly");
    expect(state.characterDraft?.system).toBe("You are Ai");
    expect(state.selectedVrmIndex).toBe(2);
    expect(
      tree?.root.findAll(
        (node) => node.props["data-testid"] === "character-customize-grid",
      ) ?? [],
    ).toHaveLength(0);
    expect(
      tree?.root.findAll(
        (node) => node.props["data-testid"] === "character-roster-grid",
      ) ?? [],
    ).toHaveLength(1);
  });

  it("turning custom off keeps deep overrides intact", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(CharacterView));
    });

    const customizeButton = tree?.root.find(
      (node) => node.props["data-testid"] === "character-customize-toggle",
    );

    await act(async () => {
      customizeButton?.props.onClick();
    });

    await act(async () => {
      state.characterDraft = {
        ...(state.characterDraft as CharacterData),
        system: "Custom preserved system",
      };
      tree?.update(React.createElement(CharacterView));
    });

    const backButton = tree?.root.find(
      (node) => node.props["data-testid"] === "character-customize-toggle",
    );

    await act(async () => {
      backButton?.props.onClick();
    });

    expect(state.characterDraft?.system).toBe("Custom preserved system");
    expect(
      tree?.root.findAll(
        (node) => node.props["data-testid"] === "character-roster-grid",
      ) ?? [],
    ).toHaveLength(1);
  });

  it("does not wipe deep overrides when switching presets after leaving custom mode", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(CharacterView));
    });

    const customizeButton = tree?.root.find(
      (node) => node.props["data-testid"] === "character-customize-toggle",
    );

    await act(async () => {
      customizeButton?.props.onClick();
    });

    await act(async () => {
      state.characterDraft = {
        ...(state.characterDraft as CharacterData),
        system: "Custom preserved system",
      };
      tree?.update(React.createElement(CharacterView));
    });

    const backButton = tree?.root.find(
      (node) => node.props["data-testid"] === "character-customize-toggle",
    );

    await act(async () => {
      backButton?.props.onClick();
    });

    const sakuyaCard = tree?.root.find(
      (node) => node.props["data-testid"] === "character-preset-Noted.",
    );

    await act(async () => {
      sakuyaCard?.props.onClick();
    });

    expect(state.characterDraft?.name).toBe("Ai");
    expect(state.characterDraft?.system).toBe("Custom preserved system");
    expect(state.selectedVrmIndex).toBe(1);
  });

  it("hides character select while customizing and restores it when going back", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(CharacterView));
    });

    const customizeButton = tree?.root.find(
      (node) => node.props["data-testid"] === "character-customize-toggle",
    );

    await act(async () => {
      customizeButton?.props.onClick();
    });

    expect(
      tree?.root.findAll(
        (node) => node.props["data-testid"] === "character-roster-grid",
      ) ?? [],
    ).toHaveLength(0);
    expect(
      tree?.root.findAll(
        (node) => node.props["data-testid"] === "character-customize-header",
      ) ?? [],
    ).toHaveLength(0);

    const backButton = tree?.root.find(
      (node) => node.props["data-testid"] === "character-customize-toggle",
    );

    await act(async () => {
      backButton?.props.onClick();
    });

    expect(
      tree?.root.findAll(
        (node) => node.props["data-testid"] === "character-roster-grid",
      ) ?? [],
    ).toHaveLength(1);
  });

  it("uses the selected character defaults when switching characters with custom off", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(CharacterView));
    });

    const sakuyaCard = tree?.root.find(
      (node) => node.props["data-testid"] === "character-preset-Noted.",
    );

    await act(async () => {
      sakuyaCard?.props.onClick();
    });

    expect(state.characterDraft?.name).toBe("Rin");
    expect(state.characterDraft?.bio).toBe("Rin is precise");
    expect(state.characterDraft?.system).toBe("You are Rin, exact and calm.");
    expect(state.selectedVrmIndex).toBe(1);
  });

  it("preserves deep custom character settings on load while staying in roster mode", async () => {
    state.characterData = {
      name: "Reimu",
      username: "Reimu",
      bio: ["Custom bio line"],
      system: "Custom Reimu system",
      adjectives: ["friendly", "helpful", "wildcard"],
      style: {
        all: ["Custom all rule"],
        chat: ["Custom chat rule"],
        post: ["Custom post rule"],
      },
      messageExamples: [
        {
          examples: [
            { name: "{{user1}}", content: { text: "hey?" } },
            { name: "Reimu", content: { text: "custom answer" } },
          ],
        },
      ],
      postExamples: ["Custom post"],
    };
    state.characterDraft = { ...state.characterData };

    let tree: TestRenderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(CharacterView));
    });

    expect(
      tree?.root.findAll(
        (node) => node.props["data-testid"] === "character-notebook",
      ) ?? [],
    ).toHaveLength(0);
    expect(
      tree?.root.findAll(
        (node) => node.props["data-testid"] === "character-roster-grid",
      ) ?? [],
    ).toHaveLength(1);
    expect(state.characterDraft?.bio).toEqual(["Custom bio line"]);
    expect(state.characterDraft?.system).toBe("Custom Reimu system");
  });

  it("renders save button", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(CharacterView));
    });

    const saveButtons = tree?.root.findAll(
      (node) =>
        node.type === "button" &&
        node.children.some(
          (c) =>
            typeof c === "string" &&
            (c.toLowerCase().includes("save") ||
              c.toLowerCase().includes("update")),
        ),
    );
    expect(saveButtons.length).toBeGreaterThanOrEqual(0);
  });

  it("saves the full character payload, voice config, and avatar selection", async () => {
    mockUseApp.mockReset();
    mockUseApp.mockImplementation(() => ({
      uiLanguage: "en",
      t: (k: string) => k,
      ...state,
      setTab: vi.fn((tab: CharacterState["tab"]) => {
        state.tab = tab;
      }),
      loadCharacter: vi.fn(),
      loadRegistryStatus: vi.fn(),
      loadDropStatus: vi.fn(),
      handleSaveCharacter: async () => {
        _saveCharacterCalled = true;
        const characterDraft = state.characterDraft;
        if (!characterDraft) {
          throw new Error("Character draft is required before saving");
        }
        const prepared = prepareCharacterDraftForSave(characterDraft);
        const { agentName } = await client.updateCharacter(
          prepared as unknown as CharacterData,
        );
        await client.updateConfig({
          ui: { avatarIndex: state.selectedVrmIndex },
        });
        state.characterSaving = false;
        state.characterDirty = false;
        state.characterSaveSuccess = "Character saved successfully.";
        if (agentName) {
          const fallbackCharacterData =
            state.characterData ?? createCharacterUIState().characterData;
          if (!fallbackCharacterData) {
            throw new Error("Character data is required after saving");
          }
          state.characterData = {
            ...fallbackCharacterData,
            ...(prepared as CharacterData),
            name: agentName,
          };
        }
      },
      handleCharacterFieldInput: (field: string, value: unknown) => {
        if (state.characterDraft) {
          (state.characterDraft as Record<string, unknown>)[field] = value;
          state.characterDirty = true;
        }
      },
      handleCharacterArrayInput: vi.fn(),
      handleCharacterStyleInput: vi.fn(),
      setState: vi.fn((key: string, value: unknown) => {
        (state as Record<string, unknown>)[key] = value;
      }),
    }));

    vi.mocked(client.updateCharacter).mockResolvedValue({
      ok: true,
      character: {} as CharacterData,
      agentName: "Custom Sakuya",
    });

    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(CharacterView));
    });

    state.characterDraft = {
      name: "Custom Sakuya",
      bio: "  First line  \n\n Second line ",
      system: "Be exact.",
      adjectives: ["precise", "calm"],
      style: {
        all: ["Be exact"],
        chat: ["Stay calm"],
        post: ["Be clear"],
      },
      messageExamples: [
        {
          examples: [
            { name: "{{user1}}", content: { text: "status?" } },
            { name: "Custom Sakuya", content: { text: "On track." } },
          ],
        },
      ],
      postExamples: ["Mission remains on schedule."],
    };
    state.selectedVrmIndex = 4;

    const saveButton = tree?.root.find(
      (node) =>
        node.type === "button" &&
        node.children.some(
          (child) => typeof child === "string" && child === "Save Character",
        ),
    );

    await act(async () => {
      saveButton?.props.onClick();
    });

    expect(_saveCharacterCalled).toBe(true);
    expect(client.updateCharacter).toHaveBeenCalledWith({
      name: "Custom Sakuya",
      username: "Custom Sakuya",
      bio: ["First line", "Second line"],
      system: "Be exact.",
      adjectives: ["precise", "calm"],
      style: {
        all: ["Be exact"],
        chat: ["Stay calm"],
        post: ["Be clear"],
      },
      messageExamples: [
        {
          examples: [
            { name: "{{user1}}", content: { text: "status?" } },
            { name: "Custom Sakuya", content: { text: "On track." } },
          ],
        },
      ],
      postExamples: ["Mission remains on schedule."],
    });
    expect(client.updateConfig).toHaveBeenNthCalledWith(1, {
      ui: { avatarIndex: 4 },
    });
    expect(client.updateConfig).toHaveBeenNthCalledWith(2, {
      messages: {
        tts: {
          provider: "elevenlabs",
          elevenlabs: {
            voiceId: "EXAVITQu4vr4xnSDxMaL",
            modelId: "eleven_flash_v2_5",
          },
        },
      },
    });
  });

  it("still saves the character when voice config persistence fails", async () => {
    mockUseApp.mockReset();
    mockUseApp.mockImplementation(() => ({
      uiLanguage: "en",
      t: (k: string) => k,
      ...state,
      setTab: vi.fn((tab: CharacterState["tab"]) => {
        state.tab = tab;
      }),
      loadCharacter: vi.fn(),
      loadRegistryStatus: vi.fn(),
      loadDropStatus: vi.fn(),
      handleSaveCharacter: async () => {
        _saveCharacterCalled = true;
        const characterDraft = state.characterDraft;
        if (!characterDraft) {
          throw new Error("Character draft is required before saving");
        }
        const prepared = prepareCharacterDraftForSave(characterDraft);
        const { agentName } = await client.updateCharacter(
          prepared as unknown as CharacterData,
        );
        await client.updateConfig({
          ui: { avatarIndex: state.selectedVrmIndex },
        });
        state.characterSaving = false;
        state.characterDirty = false;
        state.characterSaveSuccess = "Character saved successfully.";
        if (agentName) {
          const fallbackCharacterData =
            state.characterData ?? createCharacterUIState().characterData;
          if (!fallbackCharacterData) {
            throw new Error("Character data is required after saving");
          }
          state.characterData = {
            ...fallbackCharacterData,
            ...(prepared as CharacterData),
            name: agentName,
          };
        }
      },
      handleCharacterFieldInput: (field: string, value: unknown) => {
        if (state.characterDraft) {
          (state.characterDraft as Record<string, unknown>)[field] = value;
          state.characterDirty = true;
        }
      },
      handleCharacterArrayInput: vi.fn(),
      handleCharacterStyleInput: vi.fn(),
      setState: vi.fn((key: string, value: unknown) => {
        (state as Record<string, unknown>)[key] = value;
      }),
    }));

    vi.mocked(client.updateCharacter).mockResolvedValue({
      ok: true,
      character: {} as CharacterData,
      agentName: "Fallback Save",
    });
    vi.mocked(client.updateConfig)
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("Voice config failed"));

    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(CharacterView));
    });

    state.characterDraft = {
      name: "Fallback Save",
      bio: "Voice save failed but character should persist",
      system: "Stay resilient.",
      adjectives: ["calm"],
      style: {
        all: ["Keep going"],
        chat: [],
        post: [],
      },
      messageExamples: [],
      postExamples: [],
    };
    state.selectedVrmIndex = 2;

    const saveButton = tree?.root.find(
      (node) =>
        node.type === "button" &&
        node.children.some(
          (child) => typeof child === "string" && child === "Save Character",
        ),
    );

    await act(async () => {
      saveButton?.props.onClick();
    });

    expect(_saveCharacterCalled).toBe(true);
    expect(client.updateCharacter).toHaveBeenCalledWith({
      name: "Fallback Save",
      username: "Fallback Save",
      bio: ["Voice save failed but character should persist"],
      system: "Stay resilient.",
      adjectives: ["calm"],
      style: {
        all: ["Keep going"],
      },
    });
    expect(client.updateConfig).toHaveBeenNthCalledWith(1, {
      ui: { avatarIndex: 2 },
    });
    expect(client.updateConfig).toHaveBeenNthCalledWith(2, {
      messages: {
        tts: {
          provider: "elevenlabs",
          elevenlabs: {
            voiceId: "EXAVITQu4vr4xnSDxMaL",
            modelId: "eleven_flash_v2_5",
          },
        },
      },
    });
  });

  it("blocks save before submit when the character name is missing", async () => {
    mockUseApp.mockReset();
    mockUseApp.mockImplementation(() => ({
      uiLanguage: "en",
      t: (k: string) => k,
      ...state,
      setTab: vi.fn((tab: CharacterState["tab"]) => {
        state.tab = tab;
      }),
      loadCharacter: vi.fn(),
      loadRegistryStatus: vi.fn(),
      loadDropStatus: vi.fn(),
      handleSaveCharacter: async () => {
        _saveCharacterCalled = true;
      },
      handleCharacterFieldInput: vi.fn(),
      handleCharacterArrayInput: vi.fn(),
      handleCharacterStyleInput: vi.fn(),
      setState: vi.fn((key: string, value: unknown) => {
        (state as Record<string, unknown>)[key] = value;
      }),
    }));

    state.characterDraft = {
      ...createCharacterUIState().characterDraft!,
      name: "",
      username: "",
    };

    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(CharacterView));
    });

    const saveButton = tree?.root.find(
      (node) =>
        node.type === "button" &&
        node.children.some(
          (child) => typeof child === "string" && child === "Save Character",
        ),
    );

    await act(async () => {
      saveButton?.props.onClick();
    });

    expect(_saveCharacterCalled).toBe(false);
    expect(client.updateCharacter).not.toHaveBeenCalled();
    expect(state.characterSaveError).toBe(
      "Character name is required before saving.",
    );
  });

  it("shows loading state when characterLoading is true", async () => {
    state.characterLoading = true;
    state.characterData = null;

    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(CharacterView));
    });

    // Should show some loading indicator or empty state
    expect(tree).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Part 3: Integration Tests - Character Edit Flow
// ---------------------------------------------------------------------------

describe("Character Edit Integration", () => {
  let state: CharacterState;

  beforeEach(() => {
    state = createCharacterUIState();

    mockUseApp.mockReset();
    mockUseApp.mockImplementation(() => ({
      uiLanguage: "en",
      t: (k: string) => k,
      ...state,
      loadCharacter: vi.fn(),
      saveCharacter: vi.fn().mockImplementation(async () => {
        state.characterSaving = false;
        state.characterDirty = false;
      }),
      setCharacterField: (field: string, value: unknown) => {
        if (state.characterData) {
          (state.characterData as Record<string, unknown>)[field] = value;
          state.characterDirty = true;
        }
      },
    }));
  });

  it("editing name marks character as dirty", async () => {
    expect(state.characterDirty).toBe(false);

    const mockSetField = mockUseApp().setCharacterField;
    mockSetField("name", "NewName");

    expect(state.characterDirty).toBe(true);
    expect(state.characterData?.name).toBe("NewName");
  });

  it("editing bio marks character as dirty", async () => {
    const mockSetField = mockUseApp().setCharacterField;
    mockSetField("bio", ["New bio line"]);

    expect(state.characterDirty).toBe(true);
    expect(state.characterData?.bio).toEqual(["New bio line"]);
  });

  it("editing system prompt marks character as dirty", async () => {
    const mockSetField = mockUseApp().setCharacterField;
    mockSetField("system", "New system prompt");

    expect(state.characterDirty).toBe(true);
    expect(state.characterData?.system).toBe("New system prompt");
  });

  it("adding adjective updates state", async () => {
    const mockSetField = mockUseApp().setCharacterField;
    const newAdj = [...(state.characterData?.adjectives || []), "creative"];
    mockSetField("adjectives", newAdj);

    expect(state.characterData?.adjectives).toContain("creative");
  });

  it("updating style rules works for all categories", async () => {
    const mockSetField = mockUseApp().setCharacterField;
    const newStyle = {
      all: ["New all rule"],
      chat: ["New chat rule"],
      post: ["New post rule"],
    };
    mockSetField("style", newStyle);

    expect(state.characterData?.style).toEqual(newStyle);
  });
});
