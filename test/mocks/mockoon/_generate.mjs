#!/usr/bin/env node
// Programmatic Mockoon environment generator. Produces lightweight,
// realistic happy-path bodies + the standard 3 fault rules per route.
// Run: node eliza/test/mocks/mockoon/_generate.mjs
//
// gmail.json is hand-authored. Everything else is emitted from this file.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

let nextId = 0x20000;
const u = () => {
  nextId += 1;
  const hex = nextId.toString(16).padStart(12, "0");
  return `bbbb1111-aaaa-4000-8000-${hex}`;
};

const FAULT_RULES = (_label, fault) => [
  {
    target: "header",
    modifier: "X-Mockoon-Fault",
    value: fault,
    invert: false,
    operator: "equals",
  },
  {
    target: "query",
    modifier: "_fault",
    value: fault,
    invert: false,
    operator: "equals",
  },
];

function happyResponse(body, statusCode = 200) {
  return {
    uuid: u(),
    body: typeof body === "string" ? body : JSON.stringify(body, null, 2),
    latency: 0,
    statusCode,
    label: "happy path",
    headers: [{ key: "Content-Type", value: "application/json" }],
    bodyType: "INLINE",
    filePath: "",
    databucketID: "",
    sendFileAsBody: false,
    rules: [],
    rulesOperator: "OR",
    disableTemplating: false,
    fallbackTo404: false,
    default: true,
    crudKey: "id",
    callbacks: [],
  };
}

function faultResponse(label, statusCode, body, extraHeaders = []) {
  return {
    uuid: u(),
    body: typeof body === "string" ? body : JSON.stringify(body, null, 2),
    latency: 0,
    statusCode,
    label,
    headers: [
      { key: "Content-Type", value: "application/json" },
      ...extraHeaders,
    ],
    bodyType: "INLINE",
    filePath: "",
    databucketID: "",
    sendFileAsBody: false,
    rules: FAULT_RULES(label, label),
    rulesOperator: "OR",
    disableTemplating: false,
    fallbackTo404: false,
    default: false,
    crudKey: "id",
    callbacks: [],
  };
}

function defaultFaults(provider) {
  const rate = (() => {
    switch (provider) {
      case "slack":
        return { ok: false, error: "ratelimited" };
      case "discord":
        return {
          message: "You are being rate limited.",
          retry_after: 1.5,
          global: false,
          code: 0,
        };
      case "telegram":
        return {
          ok: false,
          error_code: 429,
          description: "Too Many Requests: retry after 1",
          parameters: { retry_after: 1 },
        };
      case "github":
        return {
          message: "API rate limit exceeded.",
          documentation_url:
            "https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting",
        };
      case "notion":
        return {
          object: "error",
          status: 429,
          code: "rate_limited",
          message:
            "You have been rate limited. Please try again in a few minutes.",
        };
      case "twilio":
        return {
          code: 20429,
          message: "Too Many Requests",
          more_info: "https://www.twilio.com/docs/errors/20429",
          status: 429,
        };
      case "plaid":
        return {
          error_type: "RATE_LIMIT_EXCEEDED",
          error_code: "RATE_LIMIT",
          error_message: "rate limit exceeded for client_id",
        };
      case "duffel":
        return {
          errors: [
            {
              type: "rate_limit_error",
              title: "Rate limit exceeded",
              code: "rate_limit_exceeded",
              message: "Too many requests, slow down.",
            },
          ],
        };
      case "anthropic":
        return {
          type: "error",
          error: {
            type: "rate_limit_error",
            message:
              "Number of request tokens has exceeded your per-minute rate limit",
          },
        };
      case "cerebras":
        return {
          error: {
            type: "rate_limit_exceeded",
            code: "rate_limit_exceeded",
            message: "Rate limit reached",
          },
        };
      case "spotify":
        return { error: { status: 429, message: "API rate limit exceeded" } };
      case "ntfy":
        return { code: 42909, http: 429, error: "rate limit reached" };
      case "elizacloud":
        return {
          error: "rate_limited",
          message: "Too many requests; back off and retry.",
        };
      default:
        return { error: "rate_limited" };
    }
  })();

  const auth = (() => {
    switch (provider) {
      case "slack":
        return { ok: false, error: "invalid_auth" };
      case "discord":
        return { message: "401: Unauthorized", code: 0 };
      case "telegram":
        return { ok: false, error_code: 401, description: "Unauthorized" };
      case "github":
        return {
          message: "Bad credentials",
          documentation_url: "https://docs.github.com/rest",
        };
      case "notion":
        return {
          object: "error",
          status: 401,
          code: "unauthorized",
          message: "API token is invalid.",
        };
      case "twilio":
        return {
          code: 20003,
          message: "Authentication Error - No credentials provided",
          more_info: "https://www.twilio.com/docs/errors/20003",
          status: 401,
        };
      case "plaid":
        return {
          error_type: "INVALID_INPUT",
          error_code: "INVALID_ACCESS_TOKEN",
          error_message: "the provided access token is invalid",
        };
      case "duffel":
        return {
          errors: [
            {
              type: "authentication_error",
              title: "Invalid access token",
              code: "invalid_access_token",
              message: "Your access token is invalid.",
            },
          ],
        };
      case "anthropic":
        return {
          type: "error",
          error: { type: "authentication_error", message: "invalid x-api-key" },
        };
      case "cerebras":
        return {
          error: {
            type: "invalid_request_error",
            code: "invalid_api_key",
            message: "Incorrect API key provided.",
          },
        };
      case "spotify":
        return { error: { status: 401, message: "The access token expired" } };
      case "ntfy":
        return { code: 40101, http: 401, error: "unauthorized" };
      case "elizacloud":
        return {
          error: "unauthenticated",
          message: "Eliza Cloud API key is missing or expired.",
        };
      default:
        return { error: "auth_expired" };
    }
  })();

  const server = { error: "internal_server_error" };

  return [
    faultResponse("rate_limit", 429, rate, [
      { key: "Retry-After", value: "1" },
    ]),
    faultResponse("auth_expired", 401, auth),
    faultResponse("server_error", 500, server),
  ];
}

function route(method, endpoint, happyBody, provider, statusCode = 200) {
  return {
    uuid: u(),
    type: "http",
    documentation: `${method.toUpperCase()} ${endpoint}`,
    method,
    endpoint,
    responses: [
      happyResponse(happyBody, statusCode),
      ...defaultFaults(provider),
    ],
    responseMode: null,
  };
}

function envelope({ name, port, routes }) {
  return {
    uuid: u(),
    lastMigration: 33,
    name,
    endpointPrefix: "",
    latency: 0,
    port,
    hostname: "0.0.0.0",
    folders: [],
    routes,
    rootChildren: routes.map((r) => ({ type: "route", uuid: r.uuid })),
    proxyMode: false,
    proxyHost: "",
    proxyRemovePrefix: false,
    tlsOptions: {
      enabled: false,
      type: "CERT",
      pfxPath: "",
      certPath: "",
      keyPath: "",
      caPath: "",
      passphrase: "",
    },
    cors: true,
    headers: [{ key: "Content-Type", value: "application/json" }],
    proxyReqHeaders: [{ key: "", value: "" }],
    proxyResHeaders: [{ key: "", value: "" }],
    data: [],
    callbacks: [],
  };
}

// ---------- realistic personas (shared across envs) ---------------------

const PEOPLE = [
  {
    name: "Priya Raman",
    email: "priya.raman@bluepine.dev",
    phone: "+14155551234",
  },
  {
    name: "Marcus Okafor",
    email: "marcus@delta-four.io",
    phone: "+12025553456",
  },
  { name: "Mei Tanaka", email: "mei.t@nautilus.studio", phone: "+15555550101" },
  {
    name: "Sasha Kowalski",
    email: "sasha.k@northwind.work",
    phone: "+16175557890",
  },
  { name: "Diego Alvarez", email: "diego@cinder.coop", phone: "+13105550199" },
];

// ---------- calendar -----------------------------------------------------

const calendar = envelope({
  name: "lifeops-calendar-mock",
  port: 18802,
  routes: [
<<<<<<< HEAD
    route(
      "get",
      "calendar/v3/users/me/calendarList",
      {
        kind: "calendar#calendarList",
        etag: '"3829471"',
        nextPageToken: null,
        items: [
          {
            kind: "calendar#calendarListEntry",
            id: "primary",
            summary: "shaw@eliza.dev",
            primary: true,
            accessRole: "owner",
            timeZone: "America/Los_Angeles",
          },
          {
            kind: "calendar#calendarListEntry",
            id: "team-eliza@group.calendar.google.com",
            summary: "Eliza team",
            accessRole: "writer",
            timeZone: "America/Los_Angeles",
          },
        ],
      },
      "google",
    ),
    route(
      "get",
      "calendar/v3/calendars/:calendarId/events",
      {
        kind: "calendar#events",
        etag: '"3829499"',
        timeZone: "America/Los_Angeles",
        nextPageToken: null,
        items: [
          {
            id: "ev_193a200a44b0bb02",
            status: "confirmed",
            summary: "Standup",
            description: "Daily standup — what blocked you yesterday?",
            start: {
              dateTime: "2026-05-09T16:30:00-07:00",
              timeZone: "America/Los_Angeles",
            },
            end: {
              dateTime: "2026-05-09T17:00:00-07:00",
              timeZone: "America/Los_Angeles",
            },
            attendees: [
              { email: "shaw@eliza.dev", responseStatus: "accepted" },
              { email: PEOPLE[0].email, responseStatus: "accepted" },
              { email: PEOPLE[1].email, responseStatus: "tentative" },
            ],
            conferenceData: {
              conferenceId: "abc-defg-hij",
              entryPoints: [
                {
                  entryPointType: "video",
                  uri: "https://meet.google.com/abc-defg-hij",
                },
              ],
            },
            organizer: { email: PEOPLE[0].email, displayName: PEOPLE[0].name },
          },
          {
            id: "ev_193a1ed8c0aa1f01",
            status: "confirmed",
            summary: "Q3 OKR review",
            start: { dateTime: "2026-05-12T11:00:00-07:00" },
            end: { dateTime: "2026-05-12T12:00:00-07:00" },
            attendees: [
              { email: "shaw@eliza.dev", responseStatus: "needsAction" },
              { email: PEOPLE[2].email, responseStatus: "accepted" },
            ],
          },
        ],
      },
      "google",
    ),
    route(
      "get",
      "calendar/v3/calendars/:calendarId/events/:eventId",
      {
        id: "ev_193a200a44b0bb02",
        status: "confirmed",
        summary: "Standup",
        start: { dateTime: "2026-05-09T16:30:00-07:00" },
        end: { dateTime: "2026-05-09T17:00:00-07:00" },
        attendees: [{ email: "shaw@eliza.dev", responseStatus: "accepted" }],
      },
      "google",
    ),
    route(
      "post",
      "calendar/v3/calendars/:calendarId/events",
      {
        id: "ev_new_193b000000000001",
        status: "confirmed",
        htmlLink:
          "https://calendar.google.com/event?eid=ev_new_193b000000000001",
        created: "2026-05-09T18:00:00.000Z",
        updated: "2026-05-09T18:00:00.000Z",
        summary: "Lifeops scheduled call",
        start: { dateTime: "2026-05-10T15:00:00-07:00" },
        end: { dateTime: "2026-05-10T15:30:00-07:00" },
      },
      "google",
    ),
    route(
      "patch",
      "calendar/v3/calendars/:calendarId/events/:eventId",
      {
        id: "{{urlParam 'eventId'}}",
        status: "confirmed",
        updated: "2026-05-09T18:05:12.000Z",
        summary: "Standup (rescheduled)",
      },
      "google",
    ),
=======
    route("get", "calendar/v3/users/me/calendarList", {
      kind: "calendar#calendarList",
      etag: '"3829471"',
      nextPageToken: null,
      items: [
        { kind: "calendar#calendarListEntry", id: "primary", summary: "shaw@eliza.dev", primary: true, accessRole: "owner", timeZone: "America/Los_Angeles" },
        { kind: "calendar#calendarListEntry", id: "team-eliza@group.calendar.google.com", summary: "Eliza team", accessRole: "writer", timeZone: "America/Los_Angeles" },
      ],
    }, "google"),
    route("get", "calendar/v3/calendars/:calendarId/events", {
      kind: "calendar#events",
      etag: '"3829499"',
      timeZone: "America/Los_Angeles",
      nextPageToken: null,
      items: [
        {
          id: "ev_193a200a44b0bb02",
          status: "confirmed",
          summary: "Standup",
          description: "Daily standup — what blocked you yesterday?",
          start: { dateTime: "2026-05-09T16:30:00-07:00", timeZone: "America/Los_Angeles" },
          end: { dateTime: "2026-05-09T17:00:00-07:00", timeZone: "America/Los_Angeles" },
          attendees: [
            { email: "shaw@eliza.dev", responseStatus: "accepted" },
            { email: PEOPLE[0].email, responseStatus: "accepted" },
            { email: PEOPLE[1].email, responseStatus: "tentative" },
          ],
          conferenceData: {
            conferenceId: "abc-defg-hij",
            entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }],
          },
          organizer: { email: PEOPLE[0].email, displayName: PEOPLE[0].name },
        },
        {
          id: "ev_193a1ed8c0aa1f01",
          status: "confirmed",
          summary: "Q3 OKR review",
          start: { dateTime: "2026-05-12T11:00:00-07:00" },
          end: { dateTime: "2026-05-12T12:00:00-07:00" },
          attendees: [
            { email: "shaw@eliza.dev", responseStatus: "needsAction" },
            { email: PEOPLE[2].email, responseStatus: "accepted" },
          ],
        },
      ],
    }, "google"),
    route("get", "calendar/v3/calendars/:calendarId/events/:eventId", {
      id: "ev_193a200a44b0bb02",
      status: "confirmed",
      summary: "Standup",
      start: { dateTime: "2026-05-09T16:30:00-07:00" },
      end: { dateTime: "2026-05-09T17:00:00-07:00" },
      attendees: [{ email: "shaw@eliza.dev", responseStatus: "accepted" }],
    }, "google"),
    route("post", "calendar/v3/calendars/:calendarId/events", {
      id: "ev_new_193b000000000001",
      status: "confirmed",
      htmlLink: "https://calendar.google.com/event?eid=ev_new_193b000000000001",
      created: "2026-05-09T18:00:00.000Z",
      updated: "2026-05-09T18:00:00.000Z",
      summary: "Lifeops scheduled call",
      start: { dateTime: "2026-05-10T15:00:00-07:00" },
      end: { dateTime: "2026-05-10T15:30:00-07:00" },
    }, "google"),
    route("patch", "calendar/v3/calendars/:calendarId/events/:eventId", {
      id: "{{urlParam 'eventId'}}",
      status: "confirmed",
      updated: "2026-05-09T18:05:12.000Z",
      summary: "Standup (rescheduled)",
    }, "google"),
>>>>>>> origin/shaw/fine-tune-apollo-pipeline
    {
      uuid: u(),
      type: "http",
      documentation: "calendar events.delete",
      method: "delete",
      endpoint: "calendar/v3/calendars/:calendarId/events/:eventId",
      responses: [
        { ...happyResponse("", 204), headers: [] },
        ...defaultFaults("google"),
      ],
      responseMode: null,
    },
  ],
});

// ---------- slack --------------------------------------------------------

const slack = envelope({
  name: "lifeops-slack-mock",
  port: 18803,
  routes: [
<<<<<<< HEAD
    route(
      "post",
      "chat.postMessage",
      {
        ok: true,
        channel: "C09ABCD1234",
=======
    route("post", "chat.postMessage", {
      ok: true,
      channel: "C09ABCD1234",
      ts: "1746810420.000300",
      message: {
        bot_id: "B09SLACKBOT",
        type: "message",
        text: "Mock slack message body",
        user: "U09ELIZA01",
>>>>>>> origin/shaw/fine-tune-apollo-pipeline
        ts: "1746810420.000300",
        message: {
          bot_id: "B09SLACKBOT",
          type: "message",
          text: "Mock slack message body",
          user: "U09ELIZA01",
          ts: "1746810420.000300",
          team: "T09BLUEPINE",
        },
      },
<<<<<<< HEAD
      "slack",
    ),
    route(
      "get",
      "conversations.list",
      {
        ok: true,
        channels: [
          {
            id: "C09ABCD1234",
            name: "general",
            is_channel: true,
            is_member: true,
            num_members: 12,
          },
          {
            id: "C09STANDUP01",
            name: "team-standup",
            is_channel: true,
            is_member: true,
            num_members: 4,
          },
          {
            id: "C09LIFEOPS01",
            name: "lifeops-alerts",
            is_channel: true,
            is_member: true,
            num_members: 2,
          },
        ],
        response_metadata: { next_cursor: "" },
      },
      "slack",
    ),
    route(
      "get",
      "conversations.history",
      {
        ok: true,
        messages: [
          {
            type: "message",
            user: "U09PRIYA001",
            text: "Pushing the patch in 10 — anyone want to review?",
            ts: "1746810360.001100",
          },
          {
            type: "message",
            user: "U09MARCUS01",
            text: "I'll grab it. Lifeops link?",
            ts: "1746810400.001200",
          },
          {
            type: "message",
            user: "U09ELIZA01",
            text: "Here: https://github.com/eliza/lifeops/pull/482",
            ts: "1746810410.001300",
          },
        ],
        has_more: false,
        response_metadata: { next_cursor: "" },
      },
      "slack",
    ),
    route(
      "get",
      "users.list",
      {
        ok: true,
        members: [
          {
            id: "U09ELIZA01",
            name: "shaw",
            real_name: "Shaw Walters",
            profile: { email: "shaw@eliza.dev" },
          },
          {
            id: "U09PRIYA001",
            name: "priya",
            real_name: PEOPLE[0].name,
            profile: { email: PEOPLE[0].email },
          },
          {
            id: "U09MARCUS01",
            name: "marcus",
            real_name: PEOPLE[1].name,
            profile: { email: PEOPLE[1].email },
          },
        ],
        response_metadata: { next_cursor: "" },
      },
      "slack",
    ),
    route(
      "post",
      "chat.update",
      {
        ok: true,
        channel: "C09ABCD1234",
        ts: "1746810420.000300",
        text: "Mock slack message body (updated)",
      },
      "slack",
    ),
=======
    }, "slack"),
    route("get", "conversations.list", {
      ok: true,
      channels: [
        { id: "C09ABCD1234", name: "general", is_channel: true, is_member: true, num_members: 12 },
        { id: "C09STANDUP01", name: "team-standup", is_channel: true, is_member: true, num_members: 4 },
        { id: "C09LIFEOPS01", name: "lifeops-alerts", is_channel: true, is_member: true, num_members: 2 },
      ],
      response_metadata: { next_cursor: "" },
    }, "slack"),
    route("get", "conversations.history", {
      ok: true,
      messages: [
        { type: "message", user: "U09PRIYA001", text: "Pushing the patch in 10 — anyone want to review?", ts: "1746810360.001100" },
        { type: "message", user: "U09MARCUS01", text: "I'll grab it. Lifeops link?", ts: "1746810400.001200" },
        { type: "message", user: "U09ELIZA01", text: "Here: https://github.com/eliza/lifeops/pull/482", ts: "1746810410.001300" },
      ],
      has_more: false,
      response_metadata: { next_cursor: "" },
    }, "slack"),
    route("get", "users.list", {
      ok: true,
      members: [
        { id: "U09ELIZA01", name: "shaw", real_name: "Shaw Walters", profile: { email: "shaw@eliza.dev" } },
        { id: "U09PRIYA001", name: "priya", real_name: PEOPLE[0].name, profile: { email: PEOPLE[0].email } },
        { id: "U09MARCUS01", name: "marcus", real_name: PEOPLE[1].name, profile: { email: PEOPLE[1].email } },
      ],
      response_metadata: { next_cursor: "" },
    }, "slack"),
    route("post", "chat.update", {
      ok: true,
      channel: "C09ABCD1234",
      ts: "1746810420.000300",
      text: "Mock slack message body (updated)",
    }, "slack"),
>>>>>>> origin/shaw/fine-tune-apollo-pipeline
    route("post", "reactions.add", { ok: true }, "slack"),
  ],
});

// ---------- discord ------------------------------------------------------

const discord = envelope({
  name: "lifeops-discord-mock",
  port: 18804,
  routes: [
<<<<<<< HEAD
    route(
      "get",
      "users/@me/guilds",
      [
        {
          id: "1234567890123456789",
          name: "Eliza",
          icon: null,
          owner: true,
          permissions: "2147483647",
          features: [],
        },
        {
          id: "9876543210987654321",
          name: "BluePine Dev",
          icon: null,
          owner: false,
          permissions: "1073741824",
          features: [],
        },
      ],
      "discord",
    ),
    route(
      "get",
      "guilds/:guildId/channels",
      [
        {
          id: "1111111111111111",
          type: 0,
          guild_id: "{{urlParam 'guildId'}}",
          name: "general",
          position: 0,
        },
        {
          id: "2222222222222222",
          type: 0,
          guild_id: "{{urlParam 'guildId'}}",
          name: "lifeops",
          position: 1,
        },
        {
          id: "3333333333333333",
          type: 2,
          guild_id: "{{urlParam 'guildId'}}",
          name: "Voice",
          position: 2,
        },
      ],
      "discord",
    ),
    route(
      "get",
      "channels/:channelId/messages",
      [
        {
          id: "8881111111111111",
          channel_id: "{{urlParam 'channelId'}}",
          author: {
            id: "5550000000000001",
            username: "priya",
            discriminator: "0",
            global_name: PEOPLE[0].name,
          },
          content: "Standup notes are in the doc.",
          timestamp: "2026-05-09T17:00:00.000Z",
          edited_timestamp: null,
          attachments: [],
          embeds: [],
        },
        {
          id: "8881111111111112",
          channel_id: "{{urlParam 'channelId'}}",
          author: {
            id: "5550000000000002",
            username: "marcus",
            discriminator: "0",
            global_name: PEOPLE[1].name,
          },
          content: "Reviewing now.",
          timestamp: "2026-05-09T17:01:30.000Z",
          edited_timestamp: null,
          attachments: [],
          embeds: [],
        },
      ],
      "discord",
    ),
    route(
      "post",
      "channels/:channelId/messages",
=======
    route("get", "users/@me/guilds", [
      { id: "1234567890123456789", name: "Eliza", icon: null, owner: true, permissions: "2147483647", features: [] },
      { id: "9876543210987654321", name: "BluePine Dev", icon: null, owner: false, permissions: "1073741824", features: [] },
    ], "discord"),
    route("get", "guilds/:guildId/channels", [
      { id: "1111111111111111", type: 0, guild_id: "{{urlParam 'guildId'}}", name: "general", position: 0 },
      { id: "2222222222222222", type: 0, guild_id: "{{urlParam 'guildId'}}", name: "lifeops", position: 1 },
      { id: "3333333333333333", type: 2, guild_id: "{{urlParam 'guildId'}}", name: "Voice", position: 2 },
    ], "discord"),
    route("get", "channels/:channelId/messages", [
>>>>>>> origin/shaw/fine-tune-apollo-pipeline
      {
        id: "8889999999999999",
        channel_id: "{{urlParam 'channelId'}}",
        author: { id: "5559999000000001", username: "elizabot", bot: true },
        content: "Mock outbound message",
        timestamp: "2026-05-09T18:00:00.000Z",
        edited_timestamp: null,
        attachments: [],
        embeds: [],
      },
<<<<<<< HEAD
      "discord",
    ),
=======
      {
        id: "8881111111111112",
        channel_id: "{{urlParam 'channelId'}}",
        author: { id: "5550000000000002", username: "marcus", discriminator: "0", global_name: PEOPLE[1].name },
        content: "Reviewing now.",
        timestamp: "2026-05-09T17:01:30.000Z",
        edited_timestamp: null,
        attachments: [],
        embeds: [],
      },
    ], "discord"),
    route("post", "channels/:channelId/messages", {
      id: "8889999999999999",
      channel_id: "{{urlParam 'channelId'}}",
      author: { id: "5559999000000001", username: "elizabot", bot: true },
      content: "Mock outbound message",
      timestamp: "2026-05-09T18:00:00.000Z",
      edited_timestamp: null,
      attachments: [],
      embeds: [],
    }, "discord"),
>>>>>>> origin/shaw/fine-tune-apollo-pipeline
  ],
});

// ---------- telegram -----------------------------------------------------
//
// Telegram uses a token in the URL path. Mockoon route param `:token`
// matches anything between `/bot` and the next slash, so any token
// (including a real one if the test forgets to override it) is accepted.

const telegram = envelope({
  name: "lifeops-telegram-mock",
  port: 18805,
  routes: [
<<<<<<< HEAD
    route(
      "post",
      "bot:token/sendMessage",
      {
        ok: true,
        result: {
          message_id: 4821,
          from: {
            id: 7000000001,
            is_bot: true,
            first_name: "ElizaBot",
            username: "elizabot",
          },
          chat: {
            id: -1009876543210,
            title: "Eliza Standup",
            type: "supergroup",
=======
    route("post", "bot:token/sendMessage", {
      ok: true,
      result: {
        message_id: 4821,
        from: { id: 7000000001, is_bot: true, first_name: "ElizaBot", username: "elizabot" },
        chat: { id: -1009876543210, title: "Eliza Standup", type: "supergroup" },
        date: 1746810420,
        text: "Mock outbound message",
      },
    }, "telegram"),
    route("get", "bot:token/getUpdates", {
      ok: true,
      result: [
        {
          update_id: 982344571,
          message: {
            message_id: 4810,
            from: { id: 11122233, is_bot: false, first_name: "Priya", last_name: "Raman", username: "priyar" },
            chat: { id: -1009876543210, title: "Eliza Standup", type: "supergroup" },
            date: 1746810360,
            text: "Pushing the patch in 10",
          },
        },
        {
          update_id: 982344572,
          message: {
            message_id: 4811,
            from: { id: 22233344, is_bot: false, first_name: "Marcus", username: "marcuso" },
            chat: { id: -1009876543210, title: "Eliza Standup", type: "supergroup" },
            date: 1746810400,
            text: "I'll grab it.",
>>>>>>> origin/shaw/fine-tune-apollo-pipeline
          },
          date: 1746810420,
          text: "Mock outbound message",
        },
<<<<<<< HEAD
=======
      ],
    }, "telegram"),
    route("get", "bot:token/getMe", {
      ok: true,
      result: {
        id: 7000000001,
        is_bot: true,
        first_name: "ElizaBot",
        username: "elizabot",
        can_join_groups: true,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
>>>>>>> origin/shaw/fine-tune-apollo-pipeline
      },
      "telegram",
    ),
    route(
      "get",
      "bot:token/getUpdates",
      {
        ok: true,
        result: [
          {
            update_id: 982344571,
            message: {
              message_id: 4810,
              from: {
                id: 11122233,
                is_bot: false,
                first_name: "Priya",
                last_name: "Raman",
                username: "priyar",
              },
              chat: {
                id: -1009876543210,
                title: "Eliza Standup",
                type: "supergroup",
              },
              date: 1746810360,
              text: "Pushing the patch in 10",
            },
          },
          {
            update_id: 982344572,
            message: {
              message_id: 4811,
              from: {
                id: 22233344,
                is_bot: false,
                first_name: "Marcus",
                username: "marcuso",
              },
              chat: {
                id: -1009876543210,
                title: "Eliza Standup",
                type: "supergroup",
              },
              date: 1746810400,
              text: "I'll grab it.",
            },
          },
        ],
      },
      "telegram",
    ),
    route(
      "get",
      "bot:token/getMe",
      {
        ok: true,
        result: {
          id: 7000000001,
          is_bot: true,
          first_name: "ElizaBot",
          username: "elizabot",
          can_join_groups: true,
          can_read_all_group_messages: false,
          supports_inline_queries: false,
        },
      },
      "telegram",
    ),
    route(
      "post",
      "bot:token/sendChatAction",
      { ok: true, result: true },
      "telegram",
    ),
  ],
});

// ---------- github -------------------------------------------------------

const github = envelope({
  name: "lifeops-github-mock",
  port: 18806,
  routes: [
    route(
      "get",
      "search/issues",
      {
        total_count: 2,
        incomplete_results: false,
        items: [
          {
            id: 2010101010,
            number: 482,
            state: "open",
            title: "lifeops: planner drops candidate when all signals stale",
            html_url: "https://github.com/eliza/lifeops/issues/482",
            user: { login: "priyar", id: 11122233 },
            created_at: "2026-05-08T19:14:11Z",
            updated_at: "2026-05-09T16:55:02Z",
            labels: [{ name: "bug" }, { name: "lifeops" }],
          },
          {
            id: 2010101011,
            number: 483,
            state: "open",
            title: "lifeops: surface telemetry span ids in approval queue",
            html_url: "https://github.com/eliza/lifeops/issues/483",
            user: { login: "marcuso", id: 22233344 },
            created_at: "2026-05-09T08:02:17Z",
            updated_at: "2026-05-09T17:30:00Z",
            labels: [{ name: "enhancement" }],
          },
        ],
      },
      "github",
    ),
    route(
      "get",
      "repos/:owner/:repo/issues",
      [
        {
          id: 2010101010,
          number: 482,
          state: "open",
          title: "lifeops: planner drops candidate when all signals stale",
<<<<<<< HEAD
          user: { login: "priyar" },
          labels: [{ name: "bug" }],
          created_at: "2026-05-08T19:14:11Z",
=======
          html_url: "https://github.com/eliza/lifeops/issues/482",
          user: { login: "priyar", id: 11122233 },
          created_at: "2026-05-08T19:14:11Z",
          updated_at: "2026-05-09T16:55:02Z",
          labels: [{ name: "bug" }, { name: "lifeops" }],
        },
        {
          id: 2010101011,
          number: 483,
          state: "open",
          title: "lifeops: surface telemetry span ids in approval queue",
          html_url: "https://github.com/eliza/lifeops/issues/483",
          user: { login: "marcuso", id: 22233344 },
          created_at: "2026-05-09T08:02:17Z",
          updated_at: "2026-05-09T17:30:00Z",
          labels: [{ name: "enhancement" }],
>>>>>>> origin/shaw/fine-tune-apollo-pipeline
        },
      ],
      "github",
    ),
    route(
      "get",
      "repos/:owner/:repo/pulls",
      [
        {
          id: 9911111,
          number: 482,
          state: "open",
          title: "fix(lifeops): keep candidate when only one signal is fresh",
          user: { login: "priyar" },
          head: { ref: "fix/lifeops-stale-signal-drop" },
          base: { ref: "develop" },
          created_at: "2026-05-09T10:18:00Z",
        },
      ],
      "github",
    ),
    route(
      "get",
      "repos/:owner/:repo/commits",
      [
        {
          sha: "1c2ecf0d4b6c7e89aabbccddeeff1011223344ab",
          commit: {
            author: {
              name: PEOPLE[0].name,
              email: PEOPLE[0].email,
              date: "2026-05-09T10:18:00Z",
            },
            message:
              "fix(lifeops): keep candidate when only one signal is fresh",
          },
          author: { login: "priyar", id: 11122233 },
        },
      ],
      "github",
    ),
    route(
      "post",
      "repos/:owner/:repo/issues",
      {
        id: 2010101099,
        number: 484,
        state: "open",
        title: "Mock created issue",
        html_url: "https://github.com/eliza/lifeops/issues/484",
        created_at: "2026-05-09T18:30:00Z",
      },
<<<<<<< HEAD
      "github",
      201,
    ),
=======
    ], "github"),
    route("post", "repos/:owner/:repo/issues", {
      id: 2010101099,
      number: 484,
      state: "open",
      title: "Mock created issue",
      html_url: "https://github.com/eliza/lifeops/issues/484",
      created_at: "2026-05-09T18:30:00Z",
    }, "github", 201),
>>>>>>> origin/shaw/fine-tune-apollo-pipeline
  ],
});

// ---------- notion -------------------------------------------------------

const notion = envelope({
  name: "lifeops-notion-mock",
  port: 18807,
  routes: [
    route(
      "post",
      "v1/search",
      {
        object: "list",
        results: [
          {
            object: "page",
            id: "11aa22bb-33cc-44dd-55ee-66ff77001122",
            created_time: "2026-05-01T15:00:00.000Z",
            last_edited_time: "2026-05-09T12:14:00.000Z",
            properties: {
              title: {
                type: "title",
                title: [
                  { type: "text", text: { content: "Lifeops design doc" } },
                ],
              },
            },
            url: "https://www.notion.so/Lifeops-design-doc-11aa22bb33cc44dd55ee66ff77001122",
          },
        ],
        next_cursor: null,
        has_more: false,
      },
      "notion",
    ),
    route(
      "post",
      "v1/pages",
      {
        object: "page",
        id: "99aa00bb-33cc-44dd-55ee-66ff77009999",
        created_time: "2026-05-09T18:00:00.000Z",
        last_edited_time: "2026-05-09T18:00:00.000Z",
        url: "https://www.notion.so/Mock-page-99aa00bb33cc44dd55ee66ff77009999",
      },
      "notion",
    ),
    route(
      "patch",
      "v1/blocks/:blockId/children",
      {
        object: "list",
        results: [
          {
            object: "block",
            id: "block-aaaa-0001",
            type: "paragraph",
            paragraph: {
              rich_text: [
                { type: "text", text: { content: "Mock appended block" } },
              ],
            },
          },
        ],
      },
      "notion",
    ),
    route(
      "get",
      "v1/databases/:databaseId",
      {
        object: "database",
        id: "{{urlParam 'databaseId'}}",
        title: [{ type: "text", text: { content: "Lifeops scratchpad" } }],
        properties: {
          Name: { id: "title", type: "title" },
          Status: { id: "status", type: "select" },
        },
      },
      "notion",
    ),
  ],
});

// ---------- twilio -------------------------------------------------------

const twilio = envelope({
  name: "lifeops-twilio-mock",
  port: 18808,
  routes: [
    route(
      "post",
      "2010-04-01/Accounts/:AccountSid/Messages.json",
      {
        sid: "SM193a200a44b0bb0233445566778899aa",
        account_sid: "{{urlParam 'AccountSid'}}",
        to: PEOPLE[0].phone,
        from: "+14155557777",
        body: "Mock outbound SMS",
        status: "queued",
        direction: "outbound-api",
        date_created: "Fri, 09 May 2026 18:00:00 +0000",
        price: null,
        uri: `/2010-04-01/Accounts/{{urlParam 'AccountSid'}}/Messages/SM193a200a44b0bb0233445566778899aa.json`,
      },
      "twilio",
      201,
    ),
    route(
      "post",
      "2010-04-01/Accounts/:AccountSid/Calls.json",
      {
        sid: "CA193a200a44b0bb0233445566778899bb",
        account_sid: "{{urlParam 'AccountSid'}}",
        to: PEOPLE[1].phone,
        from: "+14155557777",
        status: "queued",
        direction: "outbound-api",
        date_created: "Fri, 09 May 2026 18:00:01 +0000",
        uri: `/2010-04-01/Accounts/{{urlParam 'AccountSid'}}/Calls/CA193a200a44b0bb0233445566778899bb.json`,
      },
      "twilio",
      201,
    ),
  ],
});

// ---------- plaid (Eliza Cloud relay shape) ------------------------------

const plaid = envelope({
  name: "lifeops-plaid-mock",
  port: 18809,
  routes: [
    route(
      "post",
      "v1/eliza/plaid/link-token",
      {
        linkToken: "link-sandbox-mock-2026-05-09",
        expiration: "2026-05-09T22:00:00.000Z",
        environment: "sandbox",
      },
      "plaid",
    ),
    route(
      "post",
      "v1/eliza/plaid/exchange",
      {
        accessToken: "access-sandbox-mock-shaw-2026",
        itemId: "item-sandbox-1234",
        institution: {
          institutionId: "ins_109508",
          institutionName: "First Platypus Credit Union",
          primaryAccountMask: "0000",
          accounts: [
            {
              accountId: "acct_001",
              name: "Plaid Checking",
              mask: "0000",
              type: "depository",
              subtype: "checking",
            },
            {
              accountId: "acct_002",
              name: "Plaid Saving",
              mask: "1111",
              type: "depository",
              subtype: "savings",
            },
          ],
        },
      },
      "plaid",
    ),
    route(
      "post",
      "v1/eliza/plaid/sync",
      {
        added: [
          {
            transactionId: "txn_2026_05_09_a",
            accountId: "acct_001",
            amount: 4.75,
            isoCurrencyCode: "USD",
            date: "2026-05-09",
            name: "Sightglass Coffee",
            merchantName: "Sightglass",
            pending: false,
            category: {
              primary: "FOOD_AND_DRINK",
              detailed: "FOOD_AND_DRINK_COFFEE",
            },
          },
          {
            transactionId: "txn_2026_05_09_b",
            accountId: "acct_001",
            amount: 18.42,
            isoCurrencyCode: "USD",
            date: "2026-05-09",
            name: "Lyft *Ride 18:14",
            merchantName: "Lyft",
            pending: true,
            category: {
              primary: "TRANSPORTATION",
              detailed: "TRANSPORTATION_RIDESHARE",
            },
          },
          {
            transactionId: "txn_2026_05_09_c",
            accountId: "acct_002",
            amount: -2500.0,
            isoCurrencyCode: "USD",
            date: "2026-05-09",
            name: "Direct Deposit BLUEPINE LABS",
            merchantName: "BluePine Labs",
            pending: false,
            category: { primary: "INCOME", detailed: "INCOME_WAGES" },
          },
        ],
        modified: [],
        removed: [],
        nextCursor: "cursor-2026-05-09-end",
        hasMore: false,
      },
      "plaid",
    ),
  ],
});

// ---------- apple-reminders (bridge HTTP shim) --------------------------

const appleReminders = envelope({
  name: "lifeops-apple-reminders-mock",
  port: 18810,
  routes: [
    route(
      "get",
      "reminders/lists",
      [
        {
          id: "list-default",
          name: "Reminders",
          color: "red",
          isDefault: true,
        },
        {
          id: "list-followups",
          name: "Followups",
          color: "blue",
          isDefault: false,
        },
        { id: "list-house", name: "House", color: "green", isDefault: false },
      ],
      "default",
    ),
    route(
      "get",
      "reminders",
      [
        {
          id: "rem_2026_05_09_a",
          listId: "list-followups",
          title: "Reply to Priya about Thursday standup",
          notes: "Thread: 193a1ed8c0aa1f01",
          completed: false,
          dueDate: "2026-05-09T22:00:00.000Z",
          createdAt: "2026-05-09T17:42:11.000Z",
        },
        {
          id: "rem_2026_05_09_b",
          listId: "list-house",
          title: "Pick up dry cleaning",
          notes: null,
          completed: false,
          dueDate: "2026-05-10T01:00:00.000Z",
          createdAt: "2026-05-08T14:00:00.000Z",
        },
      ],
      "default",
    ),
    route(
      "post",
      "reminders",
      {
        id: "rem_new_2026_05_09_z",
        listId: "list-followups",
        title: "Mock new reminder",
        completed: false,
        createdAt: "2026-05-09T18:00:00.000Z",
      },
      "default",
      201,
    ),
    route(
      "patch",
      "reminders/:id",
      {
        id: "{{urlParam 'id'}}",
        completed: true,
        completedAt: "2026-05-09T18:01:00.000Z",
      },
      "default",
    ),
  ],
});

// ---------- bluebubbles --------------------------------------------------

const bluebubbles = envelope({
  name: "lifeops-bluebubbles-mock",
  port: 18811,
  routes: [
    route(
      "get",
      "api/v1/chat",
      {
        status: 200,
        message: "Success",
        data: [
          {
            guid: "iMessage;-;+14155551234",
            chatIdentifier: PEOPLE[0].phone,
            isArchived: false,
            isFiltered: false,
            displayName: PEOPLE[0].name,
            participants: [
              {
                address: PEOPLE[0].phone,
                contact: { displayName: PEOPLE[0].name },
              },
            ],
            lastMessage: {
              text: "got it, see you Thursday",
              dateCreated: 1746810400000,
            },
          },
          {
            guid: "iMessage;-;+12025553456",
            chatIdentifier: PEOPLE[1].phone,
            displayName: PEOPLE[1].name,
            participants: [
              {
                address: PEOPLE[1].phone,
                contact: { displayName: PEOPLE[1].name },
              },
            ],
            lastMessage: { text: "thanks!", dateCreated: 1746810000000 },
          },
        ],
      },
      "default",
    ),
    route(
      "get",
      "api/v1/chat/:guid/message",
      {
        status: 200,
        data: [
          {
            guid: "msg_aaa1",
            text: "hey are you free thursday?",
            isFromMe: false,
            dateCreated: 1746810000000,
          },
          {
            guid: "msg_aaa2",
            text: "yeah, what time?",
            isFromMe: true,
            dateCreated: 1746810060000,
          },
          {
            guid: "msg_aaa3",
            text: "9:30 work?",
            isFromMe: false,
            dateCreated: 1746810120000,
          },
        ],
      },
      "default",
    ),
    route(
      "post",
      "api/v1/message/text",
      {
        status: 200,
        message: "Message sent!",
        data: {
          guid: "msg_outbound_zzz1",
          text: "Mock outbound iMessage",
          isFromMe: true,
          dateCreated: 1746810500000,
        },
      },
      "default",
    ),
  ],
});

// ---------- ntfy ---------------------------------------------------------

const ntfy = envelope({
  name: "lifeops-ntfy-mock",
  port: 18812,
  routes: [
    route(
      "post",
      ":topic",
      {
        id: "OnlfgEoaMo3X",
        time: 1746810600,
        expires: 1746897000,
        event: "message",
        topic: "{{urlParam 'topic'}}",
        title: "Mock ntfy push",
        message: "delivered",
      },
      "ntfy",
    ),
  ],
});

// ---------- duffel -------------------------------------------------------

const duffel = envelope({
  name: "lifeops-duffel-mock",
  port: 18813,
  routes: [
    route(
      "post",
      "air/offer_requests",
      {
        data: {
          id: "orq_0000A2bcDe3FgHi4JkLmN5",
          live_mode: false,
          slices: [
            {
              origin: { iata_code: "JFK", name: "John F Kennedy" },
              destination: { iata_code: "LHR", name: "London Heathrow" },
              departure_date: "2026-06-12",
            },
            {
              origin: { iata_code: "LHR", name: "London Heathrow" },
              destination: { iata_code: "JFK", name: "John F Kennedy" },
              departure_date: "2026-06-19",
            },
          ],
          passengers: [{ id: "pas_001", type: "adult" }],
          offers: [
            {
              id: "off_0000A2bcDe3FgHi4JkLmN5_1",
              total_amount: "642.18",
              total_currency: "USD",
              owner: { iata_code: "BA", name: "British Airways" },
              slices: [
                {
                  origin: { iata_code: "JFK" },
                  destination: { iata_code: "LHR" },
                  departing_at: "2026-06-12T22:30:00",
                  duration: "PT7H05M",
                },
                {
                  origin: { iata_code: "LHR" },
                  destination: { iata_code: "JFK" },
                  departing_at: "2026-06-19T11:55:00",
                  duration: "PT8H10M",
                },
              ],
            },
          ],
        },
      },
      "duffel",
    ),
    route(
      "get",
      "air/offers",
      {
        data: [
          {
            id: "off_0000A2bcDe3FgHi4JkLmN5_1",
            total_amount: "642.18",
            total_currency: "USD",
            owner: { iata_code: "BA", name: "British Airways" },
          },
        ],
      },
      "duffel",
    ),
    route(
      "post",
      "air/orders",
      {
        data: {
          id: "ord_0000A2bcDe3FgHi4JkLmN5_X",
          booking_reference: "ABC123",
          total_amount: "642.18",
          total_currency: "USD",
          passengers: [
            { id: "pas_001", given_name: "Shaw", family_name: "Walters" },
          ],
        },
      },
      "duffel",
    ),
  ],
});

// ---------- anthropic (failure-injection only) ---------------------------
//
// Per the task: anthropic happy path stays live or against Cerebras. We only
// ship the failure responses so tests can simulate retry behaviour without
// burning real credit.

function anthropicFaultOnlyRoute(method, endpoint) {
  return {
    uuid: u(),
    type: "http",
    documentation: `${method.toUpperCase()} ${endpoint} (failure-injection only)`,
    method,
    endpoint,
    responses: [
      // Default response: an explicit "use cerebras" 503 so silent fallthrough
      // is loud. Tests should always send a fault toggle.
      {
        ...happyResponse(
          {
            type: "error",
            error: {
              type: "overloaded_error",
              message:
                "Mockoon anthropic env is failure-injection only — point the SDK at cerebras for happy-path completions.",
            },
          },
          503,
        ),
        label: "default (failure-only env)",
        default: true,
      },
      ...defaultFaults("anthropic"),
    ],
    responseMode: null,
  };
}

const anthropic = envelope({
  name: "lifeops-anthropic-mock",
  port: 18814,
  routes: [
    anthropicFaultOnlyRoute("post", "v1/messages"),
    anthropicFaultOnlyRoute("post", "v1/messages/count_tokens"),
  ],
});

// ---------- cerebras -----------------------------------------------------

const cerebras = envelope({
  name: "lifeops-cerebras-mock",
  port: 18815,
  routes: [
    route(
      "post",
      "v1/chat/completions",
      {
        id: "chatcmpl-mock-2026-05-09-001",
        object: "chat.completion",
        created: 1746810600,
        model: "gpt-oss-120b",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                '{"action":"route_to_inbox","confidence":0.91,"rationale":"Routine standup confirmation; not urgent."}',
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 184, completion_tokens: 31, total_tokens: 215 },
      },
      "cerebras",
    ),
    route(
      "post",
      "v1/embeddings",
      {
        object: "list",
        data: [
          {
            object: "embedding",
            index: 0,
            embedding: [
              0.0123, -0.0456, 0.0789, -0.0234, 0.0567, -0.089, 0.0345, -0.0678,
            ],
          },
        ],
        model: "text-embedding-3-small",
        usage: { prompt_tokens: 8, total_tokens: 8 },
      },
      "cerebras",
    ),
  ],
});

// ---------- eliza-cloud --------------------------------------------------

const elizaCloud = envelope({
  name: "lifeops-eliza-cloud-mock",
  port: 18816,
  routes: [
    route(
      "post",
      "api/v1/eliza/auth/token",
      {
        apiKey: "elc_test_2026_05_09_shaw",
        expiresAt: "2026-08-09T00:00:00.000Z",
        agentId: "agent-shaw-default",
      },
      "elizacloud",
    ),
    route(
      "get",
      "api/v1/eliza/agents/me",
      {
        id: "agent-shaw-default",
        handle: "shaw",
        displayName: "Shaw",
        tier: "pro",
        monetization: { revShare: 0.7, payoutCadence: "monthly" },
      },
      "elizacloud",
    ),
    route(
      "get",
      "api/v1/eliza/billing/balance",
      {
        currency: "USD",
        balance: 18.42,
        reservedCredits: 1.0,
        lastUpdated: "2026-05-09T17:30:00.000Z",
        lifetimeUsage: 124.6,
      },
      "elizacloud",
    ),
    route(
      "post",
      "api/v1/eliza/plaid/link-token",
      {
        linkToken: "link-sandbox-mock-2026-05-09",
        expiration: "2026-05-09T22:00:00.000Z",
        environment: "sandbox",
      },
      "elizacloud",
    ),
    route(
      "post",
      "api/v1/eliza/paypal/authorize",
      {
        authorizationUrl:
          "https://www.paypal.com/connect?flowEntry=static&client_id=mock&scope=openid",
        state: "state-mock-2026-05-09",
      },
      "elizacloud",
    ),
    route(
      "post",
      "api/v1/eliza/schedule/sync",
      {
        synced: 12,
        pruned: 1,
        cursor: "cursor-2026-05-09-schedule-end",
      },
      "elizacloud",
    ),
  ],
});

// ---------- spotify ------------------------------------------------------

const spotify = envelope({
  name: "lifeops-spotify-mock",
  port: 18817,
  routes: [
<<<<<<< HEAD
    route(
      "get",
      "v1/me",
      {
        id: "shaweliza",
        display_name: "Shaw",
        email: "shaw@eliza.dev",
        country: "US",
        product: "premium",
        images: [],
=======
    route("get", "v1/me", {
      id: "shaweliza",
      display_name: "Shaw",
      email: "shaw@eliza.dev",
      country: "US",
      product: "premium",
      images: [],
    }, "spotify"),
    route("get", "v1/me/player/currently-playing", {
      timestamp: 1746810600000,
      progress_ms: 84210,
      is_playing: true,
      currently_playing_type: "track",
      item: {
        id: "0V8AZRO3vcmoCJVfXSjynj",
        name: "Sandstorm",
        artists: [{ id: "27dt7vDlxdLuF1FycZ51RQ", name: "Darude" }],
        album: { id: "1QqLvzS1d1xqklrTHWWgUe", name: "Before the Storm" },
        duration_ms: 233000,
>>>>>>> origin/shaw/fine-tune-apollo-pipeline
      },
      "spotify",
    ),
    route(
      "get",
      "v1/me/player/currently-playing",
      {
        timestamp: 1746810600000,
        progress_ms: 84210,
        is_playing: true,
        currently_playing_type: "track",
        item: {
          id: "0V8AZRO3vcmoCJVfXSjynj",
          name: "Sandstorm",
          artists: [{ id: "27dt7vDlxdLuF1FycZ51RQ", name: "Darude" }],
          album: { id: "1QqLvzS1d1xqklrTHWWgUe", name: "Before the Storm" },
          duration_ms: 233000,
        },
      },
      "spotify",
    ),
  ],
});

// ---------- signal -------------------------------------------------------

const signal = envelope({
  name: "lifeops-signal-mock",
  port: 18818,
  routes: [
    route(
      "get",
      "v1/receive/:account",
      [
        {
          envelope: {
            source: PEOPLE[2].phone,
            sourceNumber: PEOPLE[2].phone,
            sourceName: PEOPLE[2].name,
            timestamp: 1746810400000,
            dataMessage: {
              timestamp: 1746810400000,
              message: "Are we still on for tomorrow?",
              expiresInSeconds: 0,
              viewOnce: false,
            },
          },
        },
      ],
      "default",
    ),
    route(
      "post",
      "v2/send",
      {
        results: [
          { recipientAddress: { number: PEOPLE[2].phone }, type: "SUCCESS" },
        ],
        timestamp: 1746810500000,
      },
      "default",
    ),
  ],
});

// ---------- write all ----------------------------------------------------

const ENVS = {
  "calendar.json": calendar,
  "slack.json": slack,
  "discord.json": discord,
  "telegram.json": telegram,
  "github.json": github,
  "notion.json": notion,
  "twilio.json": twilio,
  "plaid.json": plaid,
  "apple-reminders.json": appleReminders,
  "bluebubbles.json": bluebubbles,
  "ntfy.json": ntfy,
  "duffel.json": duffel,
  "anthropic.json": anthropic,
  "cerebras.json": cerebras,
  "eliza-cloud.json": elizaCloud,
  "spotify.json": spotify,
  "signal.json": signal,
};

for (const [name, env] of Object.entries(ENVS)) {
  const path = join(HERE, name);
  writeFileSync(path, `${JSON.stringify(env, null, 2)}\n`);
  console.log(`wrote ${name} (${env.routes.length} routes, port ${env.port})`);
}
