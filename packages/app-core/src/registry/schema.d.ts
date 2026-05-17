import { z } from "zod";
export declare const configFieldSchema: z.ZodObject<
  {
    type: z.ZodEnum<{
      string: "string";
      number: "number";
      boolean: "boolean";
      json: "json";
      url: "url";
      select: "select";
      textarea: "textarea";
      multiselect: "multiselect";
      secret: "secret";
      "file-path": "file-path";
    }>;
    required: z.ZodBoolean;
    sensitive: z.ZodOptional<z.ZodBoolean>;
    default: z.ZodOptional<
      z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodNull]>
    >;
    label: z.ZodOptional<z.ZodString>;
    help: z.ZodOptional<z.ZodString>;
    placeholder: z.ZodOptional<z.ZodString>;
    group: z.ZodOptional<z.ZodString>;
    order: z.ZodOptional<z.ZodNumber>;
    width: z.ZodOptional<
      z.ZodEnum<{
        full: "full";
        half: "half";
        third: "third";
      }>
    >;
    advanced: z.ZodOptional<z.ZodBoolean>;
    hidden: z.ZodOptional<z.ZodBoolean>;
    readonly: z.ZodOptional<z.ZodBoolean>;
    icon: z.ZodOptional<z.ZodString>;
    options: z.ZodOptional<
      z.ZodArray<
        z.ZodObject<
          {
            value: z.ZodString;
            label: z.ZodString;
            description: z.ZodOptional<z.ZodString>;
            icon: z.ZodOptional<z.ZodString>;
            disabled: z.ZodOptional<z.ZodBoolean>;
          },
          z.core.$strip
        >
      >
    >;
    pattern: z.ZodOptional<z.ZodString>;
    patternError: z.ZodOptional<z.ZodString>;
    min: z.ZodOptional<z.ZodNumber>;
    max: z.ZodOptional<z.ZodNumber>;
    step: z.ZodOptional<z.ZodNumber>;
    unit: z.ZodOptional<z.ZodString>;
    visible: z.ZodOptional<
      z.ZodType<
        {
          key: string;
          equals?: unknown;
          in?: unknown[];
          notEquals?: unknown;
        },
        unknown,
        z.core.$ZodTypeInternals<
          {
            key: string;
            equals?: unknown;
            in?: unknown[];
            notEquals?: unknown;
          },
          unknown
        >
      >
    >;
  },
  z.core.$strip
>;
export type ConfigField = z.infer<typeof configFieldSchema>;
declare const secondarySurfaceSchema: z.ZodEnum<{
  "chat-apps-section": "chat-apps-section";
  "companion-shell": "companion-shell";
  "settings-integrations": "settings-integrations";
}>;
export declare const renderSchema: z.ZodObject<
  {
    visible: z.ZodDefault<z.ZodBoolean>;
    pinTo: z.ZodDefault<
      z.ZodArray<
        z.ZodEnum<{
          "chat-apps-section": "chat-apps-section";
          "companion-shell": "companion-shell";
          "settings-integrations": "settings-integrations";
        }>
      >
    >;
    style: z.ZodDefault<
      z.ZodEnum<{
        card: "card";
        "setup-panel": "setup-panel";
        "hero-card": "hero-card";
      }>
    >;
    icon: z.ZodOptional<z.ZodString>;
    heroImage: z.ZodOptional<z.ZodString>;
    group: z.ZodString;
    groupOrder: z.ZodOptional<z.ZodNumber>;
    actions: z.ZodDefault<
      z.ZodArray<
        z.ZodEnum<{
          install: "install";
          stop: "stop";
          uninstall: "uninstall";
          enable: "enable";
          configure: "configure";
          launch: "launch";
          attach: "attach";
          detach: "detach";
          "setup-guide": "setup-guide";
        }>
      >
    >;
  },
  z.core.$strip
>;
export type RenderHints = z.infer<typeof renderSchema>;
export type SecondarySurface = z.infer<typeof secondarySurfaceSchema>;
export declare const resourcesSchema: z.ZodObject<
  {
    homepage: z.ZodOptional<z.ZodString>;
    repository: z.ZodOptional<z.ZodString>;
    setupGuideUrl: z.ZodOptional<z.ZodString>;
  },
  z.core.$strip
>;
export type Resources = z.infer<typeof resourcesSchema>;
export declare const appLaunchSchema: z.ZodObject<
  {
    type: z.ZodEnum<{
      "internal-tab": "internal-tab";
      overlay: "overlay";
      "server-launch": "server-launch";
    }>;
    target: z.ZodOptional<z.ZodString>;
    url: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    viewer: z.ZodOptional<
      z.ZodObject<
        {
          url: z.ZodString;
          embedParams: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
          postMessageAuth: z.ZodOptional<z.ZodBoolean>;
          sandbox: z.ZodOptional<z.ZodString>;
        },
        z.core.$strip
      >
    >;
    session: z.ZodOptional<
      z.ZodObject<
        {
          mode: z.ZodEnum<{
            external: "external";
            viewer: "viewer";
            "spectate-and-steer": "spectate-and-steer";
          }>;
          features: z.ZodOptional<
            z.ZodArray<
              z.ZodEnum<{
                pause: "pause";
                resume: "resume";
                telemetry: "telemetry";
                commands: "commands";
                suggestions: "suggestions";
              }>
            >
          >;
        },
        z.core.$strip
      >
    >;
    supports: z.ZodOptional<
      z.ZodObject<
        {
          v0: z.ZodBoolean;
          v1: z.ZodBoolean;
          v2: z.ZodBoolean;
        },
        z.core.$strip
      >
    >;
    npm: z.ZodOptional<
      z.ZodObject<
        {
          package: z.ZodString;
          v0Version: z.ZodNullable<z.ZodString>;
          v1Version: z.ZodNullable<z.ZodString>;
          v2Version: z.ZodNullable<z.ZodString>;
        },
        z.core.$strip
      >
    >;
    capabilities: z.ZodDefault<z.ZodArray<z.ZodString>>;
    uiExtension: z.ZodOptional<
      z.ZodObject<
        {
          detailPanelId: z.ZodString;
        },
        z.core.$strip
      >
    >;
    curatedSlug: z.ZodOptional<z.ZodString>;
    routePlugin: z.ZodOptional<
      z.ZodObject<
        {
          specifier: z.ZodString;
          exportName: z.ZodOptional<z.ZodString>;
        },
        z.core.$strip
      >
    >;
    mainTab: z.ZodOptional<z.ZodBoolean>;
  },
  z.core.$strip
>;
export type AppLaunch = z.infer<typeof appLaunchSchema>;
export declare const pluginEntrySchema: z.ZodObject<
  {
    kind: z.ZodLiteral<"plugin">;
    subtype: z.ZodEnum<{
      agents: "agents";
      documents: "documents";
      media: "media";
      automation: "automation";
      database: "database";
      voice: "voice";
      "ai-provider": "ai-provider";
      feature: "feature";
      other: "other";
      blockchain: "blockchain";
      devtools: "devtools";
      storage: "storage";
      gaming: "gaming";
    }>;
    id: z.ZodString;
    name: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    npmName: z.ZodOptional<z.ZodString>;
    version: z.ZodOptional<z.ZodString>;
    releaseStream: z.ZodOptional<
      z.ZodEnum<{
        latest: "latest";
        beta: "beta";
      }>
    >;
    source: z.ZodDefault<
      z.ZodEnum<{
        store: "store";
        bundled: "bundled";
      }>
    >;
    tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
    config: z.ZodDefault<
      z.ZodRecord<
        z.ZodString,
        z.ZodObject<
          {
            type: z.ZodEnum<{
              string: "string";
              number: "number";
              boolean: "boolean";
              json: "json";
              url: "url";
              select: "select";
              textarea: "textarea";
              multiselect: "multiselect";
              secret: "secret";
              "file-path": "file-path";
            }>;
            required: z.ZodBoolean;
            sensitive: z.ZodOptional<z.ZodBoolean>;
            default: z.ZodOptional<
              z.ZodUnion<
                readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodNull]
              >
            >;
            label: z.ZodOptional<z.ZodString>;
            help: z.ZodOptional<z.ZodString>;
            placeholder: z.ZodOptional<z.ZodString>;
            group: z.ZodOptional<z.ZodString>;
            order: z.ZodOptional<z.ZodNumber>;
            width: z.ZodOptional<
              z.ZodEnum<{
                full: "full";
                half: "half";
                third: "third";
              }>
            >;
            advanced: z.ZodOptional<z.ZodBoolean>;
            hidden: z.ZodOptional<z.ZodBoolean>;
            readonly: z.ZodOptional<z.ZodBoolean>;
            icon: z.ZodOptional<z.ZodString>;
            options: z.ZodOptional<
              z.ZodArray<
                z.ZodObject<
                  {
                    value: z.ZodString;
                    label: z.ZodString;
                    description: z.ZodOptional<z.ZodString>;
                    icon: z.ZodOptional<z.ZodString>;
                    disabled: z.ZodOptional<z.ZodBoolean>;
                  },
                  z.core.$strip
                >
              >
            >;
            pattern: z.ZodOptional<z.ZodString>;
            patternError: z.ZodOptional<z.ZodString>;
            min: z.ZodOptional<z.ZodNumber>;
            max: z.ZodOptional<z.ZodNumber>;
            step: z.ZodOptional<z.ZodNumber>;
            unit: z.ZodOptional<z.ZodString>;
            visible: z.ZodOptional<
              z.ZodType<
                {
                  key: string;
                  equals?: unknown;
                  in?: unknown[];
                  notEquals?: unknown;
                },
                unknown,
                z.core.$ZodTypeInternals<
                  {
                    key: string;
                    equals?: unknown;
                    in?: unknown[];
                    notEquals?: unknown;
                  },
                  unknown
                >
              >
            >;
          },
          z.core.$strip
        >
      >
    >;
    render: z.ZodObject<
      {
        visible: z.ZodDefault<z.ZodBoolean>;
        pinTo: z.ZodDefault<
          z.ZodArray<
            z.ZodEnum<{
              "chat-apps-section": "chat-apps-section";
              "companion-shell": "companion-shell";
              "settings-integrations": "settings-integrations";
            }>
          >
        >;
        style: z.ZodDefault<
          z.ZodEnum<{
            card: "card";
            "setup-panel": "setup-panel";
            "hero-card": "hero-card";
          }>
        >;
        icon: z.ZodOptional<z.ZodString>;
        heroImage: z.ZodOptional<z.ZodString>;
        group: z.ZodString;
        groupOrder: z.ZodOptional<z.ZodNumber>;
        actions: z.ZodDefault<
          z.ZodArray<
            z.ZodEnum<{
              install: "install";
              stop: "stop";
              uninstall: "uninstall";
              enable: "enable";
              configure: "configure";
              launch: "launch";
              attach: "attach";
              detach: "detach";
              "setup-guide": "setup-guide";
            }>
          >
        >;
      },
      z.core.$strip
    >;
    resources: z.ZodDefault<
      z.ZodObject<
        {
          homepage: z.ZodOptional<z.ZodString>;
          repository: z.ZodOptional<z.ZodString>;
          setupGuideUrl: z.ZodOptional<z.ZodString>;
        },
        z.core.$strip
      >
    >;
    dependsOn: z.ZodDefault<z.ZodArray<z.ZodString>>;
  },
  z.core.$strip
>;
export declare const connectorEntrySchema: z.ZodObject<
  {
    kind: z.ZodLiteral<"connector">;
    subtype: z.ZodEnum<{
      email: "email";
      calendar: "calendar";
      messaging: "messaging";
      social: "social";
      streaming: "streaming";
      other: "other";
    }>;
    auth: z.ZodOptional<
      z.ZodObject<
        {
          kind: z.ZodEnum<{
            none: "none";
            credentials: "credentials";
            oauth: "oauth";
            token: "token";
          }>;
          credentialKeys: z.ZodDefault<z.ZodArray<z.ZodString>>;
        },
        z.core.$strip
      >
    >;
    id: z.ZodString;
    name: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    npmName: z.ZodOptional<z.ZodString>;
    version: z.ZodOptional<z.ZodString>;
    releaseStream: z.ZodOptional<
      z.ZodEnum<{
        latest: "latest";
        beta: "beta";
      }>
    >;
    source: z.ZodDefault<
      z.ZodEnum<{
        store: "store";
        bundled: "bundled";
      }>
    >;
    tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
    config: z.ZodDefault<
      z.ZodRecord<
        z.ZodString,
        z.ZodObject<
          {
            type: z.ZodEnum<{
              string: "string";
              number: "number";
              boolean: "boolean";
              json: "json";
              url: "url";
              select: "select";
              textarea: "textarea";
              multiselect: "multiselect";
              secret: "secret";
              "file-path": "file-path";
            }>;
            required: z.ZodBoolean;
            sensitive: z.ZodOptional<z.ZodBoolean>;
            default: z.ZodOptional<
              z.ZodUnion<
                readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodNull]
              >
            >;
            label: z.ZodOptional<z.ZodString>;
            help: z.ZodOptional<z.ZodString>;
            placeholder: z.ZodOptional<z.ZodString>;
            group: z.ZodOptional<z.ZodString>;
            order: z.ZodOptional<z.ZodNumber>;
            width: z.ZodOptional<
              z.ZodEnum<{
                full: "full";
                half: "half";
                third: "third";
              }>
            >;
            advanced: z.ZodOptional<z.ZodBoolean>;
            hidden: z.ZodOptional<z.ZodBoolean>;
            readonly: z.ZodOptional<z.ZodBoolean>;
            icon: z.ZodOptional<z.ZodString>;
            options: z.ZodOptional<
              z.ZodArray<
                z.ZodObject<
                  {
                    value: z.ZodString;
                    label: z.ZodString;
                    description: z.ZodOptional<z.ZodString>;
                    icon: z.ZodOptional<z.ZodString>;
                    disabled: z.ZodOptional<z.ZodBoolean>;
                  },
                  z.core.$strip
                >
              >
            >;
            pattern: z.ZodOptional<z.ZodString>;
            patternError: z.ZodOptional<z.ZodString>;
            min: z.ZodOptional<z.ZodNumber>;
            max: z.ZodOptional<z.ZodNumber>;
            step: z.ZodOptional<z.ZodNumber>;
            unit: z.ZodOptional<z.ZodString>;
            visible: z.ZodOptional<
              z.ZodType<
                {
                  key: string;
                  equals?: unknown;
                  in?: unknown[];
                  notEquals?: unknown;
                },
                unknown,
                z.core.$ZodTypeInternals<
                  {
                    key: string;
                    equals?: unknown;
                    in?: unknown[];
                    notEquals?: unknown;
                  },
                  unknown
                >
              >
            >;
          },
          z.core.$strip
        >
      >
    >;
    render: z.ZodObject<
      {
        visible: z.ZodDefault<z.ZodBoolean>;
        pinTo: z.ZodDefault<
          z.ZodArray<
            z.ZodEnum<{
              "chat-apps-section": "chat-apps-section";
              "companion-shell": "companion-shell";
              "settings-integrations": "settings-integrations";
            }>
          >
        >;
        style: z.ZodDefault<
          z.ZodEnum<{
            card: "card";
            "setup-panel": "setup-panel";
            "hero-card": "hero-card";
          }>
        >;
        icon: z.ZodOptional<z.ZodString>;
        heroImage: z.ZodOptional<z.ZodString>;
        group: z.ZodString;
        groupOrder: z.ZodOptional<z.ZodNumber>;
        actions: z.ZodDefault<
          z.ZodArray<
            z.ZodEnum<{
              install: "install";
              stop: "stop";
              uninstall: "uninstall";
              enable: "enable";
              configure: "configure";
              launch: "launch";
              attach: "attach";
              detach: "detach";
              "setup-guide": "setup-guide";
            }>
          >
        >;
      },
      z.core.$strip
    >;
    resources: z.ZodDefault<
      z.ZodObject<
        {
          homepage: z.ZodOptional<z.ZodString>;
          repository: z.ZodOptional<z.ZodString>;
          setupGuideUrl: z.ZodOptional<z.ZodString>;
        },
        z.core.$strip
      >
    >;
    dependsOn: z.ZodDefault<z.ZodArray<z.ZodString>>;
  },
  z.core.$strip
>;
export declare const appEntrySchema: z.ZodObject<
  {
    kind: z.ZodLiteral<"app">;
    subtype: z.ZodEnum<{
      game: "game";
      marketplace: "marketplace";
      tool: "tool";
      shell: "shell";
      other: "other";
      trading: "trading";
    }>;
    launch: z.ZodObject<
      {
        type: z.ZodEnum<{
          "internal-tab": "internal-tab";
          overlay: "overlay";
          "server-launch": "server-launch";
        }>;
        target: z.ZodOptional<z.ZodString>;
        url: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        viewer: z.ZodOptional<
          z.ZodObject<
            {
              url: z.ZodString;
              embedParams: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
              postMessageAuth: z.ZodOptional<z.ZodBoolean>;
              sandbox: z.ZodOptional<z.ZodString>;
            },
            z.core.$strip
          >
        >;
        session: z.ZodOptional<
          z.ZodObject<
            {
              mode: z.ZodEnum<{
                external: "external";
                viewer: "viewer";
                "spectate-and-steer": "spectate-and-steer";
              }>;
              features: z.ZodOptional<
                z.ZodArray<
                  z.ZodEnum<{
                    pause: "pause";
                    resume: "resume";
                    telemetry: "telemetry";
                    commands: "commands";
                    suggestions: "suggestions";
                  }>
                >
              >;
            },
            z.core.$strip
          >
        >;
        supports: z.ZodOptional<
          z.ZodObject<
            {
              v0: z.ZodBoolean;
              v1: z.ZodBoolean;
              v2: z.ZodBoolean;
            },
            z.core.$strip
          >
        >;
        npm: z.ZodOptional<
          z.ZodObject<
            {
              package: z.ZodString;
              v0Version: z.ZodNullable<z.ZodString>;
              v1Version: z.ZodNullable<z.ZodString>;
              v2Version: z.ZodNullable<z.ZodString>;
            },
            z.core.$strip
          >
        >;
        capabilities: z.ZodDefault<z.ZodArray<z.ZodString>>;
        uiExtension: z.ZodOptional<
          z.ZodObject<
            {
              detailPanelId: z.ZodString;
            },
            z.core.$strip
          >
        >;
        curatedSlug: z.ZodOptional<z.ZodString>;
        routePlugin: z.ZodOptional<
          z.ZodObject<
            {
              specifier: z.ZodString;
              exportName: z.ZodOptional<z.ZodString>;
            },
            z.core.$strip
          >
        >;
        mainTab: z.ZodOptional<z.ZodBoolean>;
      },
      z.core.$strip
    >;
    id: z.ZodString;
    name: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    npmName: z.ZodOptional<z.ZodString>;
    version: z.ZodOptional<z.ZodString>;
    releaseStream: z.ZodOptional<
      z.ZodEnum<{
        latest: "latest";
        beta: "beta";
      }>
    >;
    source: z.ZodDefault<
      z.ZodEnum<{
        store: "store";
        bundled: "bundled";
      }>
    >;
    tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
    config: z.ZodDefault<
      z.ZodRecord<
        z.ZodString,
        z.ZodObject<
          {
            type: z.ZodEnum<{
              string: "string";
              number: "number";
              boolean: "boolean";
              json: "json";
              url: "url";
              select: "select";
              textarea: "textarea";
              multiselect: "multiselect";
              secret: "secret";
              "file-path": "file-path";
            }>;
            required: z.ZodBoolean;
            sensitive: z.ZodOptional<z.ZodBoolean>;
            default: z.ZodOptional<
              z.ZodUnion<
                readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodNull]
              >
            >;
            label: z.ZodOptional<z.ZodString>;
            help: z.ZodOptional<z.ZodString>;
            placeholder: z.ZodOptional<z.ZodString>;
            group: z.ZodOptional<z.ZodString>;
            order: z.ZodOptional<z.ZodNumber>;
            width: z.ZodOptional<
              z.ZodEnum<{
                full: "full";
                half: "half";
                third: "third";
              }>
            >;
            advanced: z.ZodOptional<z.ZodBoolean>;
            hidden: z.ZodOptional<z.ZodBoolean>;
            readonly: z.ZodOptional<z.ZodBoolean>;
            icon: z.ZodOptional<z.ZodString>;
            options: z.ZodOptional<
              z.ZodArray<
                z.ZodObject<
                  {
                    value: z.ZodString;
                    label: z.ZodString;
                    description: z.ZodOptional<z.ZodString>;
                    icon: z.ZodOptional<z.ZodString>;
                    disabled: z.ZodOptional<z.ZodBoolean>;
                  },
                  z.core.$strip
                >
              >
            >;
            pattern: z.ZodOptional<z.ZodString>;
            patternError: z.ZodOptional<z.ZodString>;
            min: z.ZodOptional<z.ZodNumber>;
            max: z.ZodOptional<z.ZodNumber>;
            step: z.ZodOptional<z.ZodNumber>;
            unit: z.ZodOptional<z.ZodString>;
            visible: z.ZodOptional<
              z.ZodType<
                {
                  key: string;
                  equals?: unknown;
                  in?: unknown[];
                  notEquals?: unknown;
                },
                unknown,
                z.core.$ZodTypeInternals<
                  {
                    key: string;
                    equals?: unknown;
                    in?: unknown[];
                    notEquals?: unknown;
                  },
                  unknown
                >
              >
            >;
          },
          z.core.$strip
        >
      >
    >;
    render: z.ZodObject<
      {
        visible: z.ZodDefault<z.ZodBoolean>;
        pinTo: z.ZodDefault<
          z.ZodArray<
            z.ZodEnum<{
              "chat-apps-section": "chat-apps-section";
              "companion-shell": "companion-shell";
              "settings-integrations": "settings-integrations";
            }>
          >
        >;
        style: z.ZodDefault<
          z.ZodEnum<{
            card: "card";
            "setup-panel": "setup-panel";
            "hero-card": "hero-card";
          }>
        >;
        icon: z.ZodOptional<z.ZodString>;
        heroImage: z.ZodOptional<z.ZodString>;
        group: z.ZodString;
        groupOrder: z.ZodOptional<z.ZodNumber>;
        actions: z.ZodDefault<
          z.ZodArray<
            z.ZodEnum<{
              install: "install";
              stop: "stop";
              uninstall: "uninstall";
              enable: "enable";
              configure: "configure";
              launch: "launch";
              attach: "attach";
              detach: "detach";
              "setup-guide": "setup-guide";
            }>
          >
        >;
      },
      z.core.$strip
    >;
    resources: z.ZodDefault<
      z.ZodObject<
        {
          homepage: z.ZodOptional<z.ZodString>;
          repository: z.ZodOptional<z.ZodString>;
          setupGuideUrl: z.ZodOptional<z.ZodString>;
        },
        z.core.$strip
      >
    >;
    dependsOn: z.ZodDefault<z.ZodArray<z.ZodString>>;
  },
  z.core.$strip
>;
export declare const registryEntrySchema: z.ZodDiscriminatedUnion<
  [
    z.ZodObject<
      {
        kind: z.ZodLiteral<"plugin">;
        subtype: z.ZodEnum<{
          agents: "agents";
          documents: "documents";
          media: "media";
          automation: "automation";
          database: "database";
          voice: "voice";
          "ai-provider": "ai-provider";
          feature: "feature";
          other: "other";
          blockchain: "blockchain";
          devtools: "devtools";
          storage: "storage";
          gaming: "gaming";
        }>;
        id: z.ZodString;
        name: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        npmName: z.ZodOptional<z.ZodString>;
        version: z.ZodOptional<z.ZodString>;
        releaseStream: z.ZodOptional<
          z.ZodEnum<{
            latest: "latest";
            beta: "beta";
          }>
        >;
        source: z.ZodDefault<
          z.ZodEnum<{
            store: "store";
            bundled: "bundled";
          }>
        >;
        tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
        config: z.ZodDefault<
          z.ZodRecord<
            z.ZodString,
            z.ZodObject<
              {
                type: z.ZodEnum<{
                  string: "string";
                  number: "number";
                  boolean: "boolean";
                  json: "json";
                  url: "url";
                  select: "select";
                  textarea: "textarea";
                  multiselect: "multiselect";
                  secret: "secret";
                  "file-path": "file-path";
                }>;
                required: z.ZodBoolean;
                sensitive: z.ZodOptional<z.ZodBoolean>;
                default: z.ZodOptional<
                  z.ZodUnion<
                    readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodNull]
                  >
                >;
                label: z.ZodOptional<z.ZodString>;
                help: z.ZodOptional<z.ZodString>;
                placeholder: z.ZodOptional<z.ZodString>;
                group: z.ZodOptional<z.ZodString>;
                order: z.ZodOptional<z.ZodNumber>;
                width: z.ZodOptional<
                  z.ZodEnum<{
                    full: "full";
                    half: "half";
                    third: "third";
                  }>
                >;
                advanced: z.ZodOptional<z.ZodBoolean>;
                hidden: z.ZodOptional<z.ZodBoolean>;
                readonly: z.ZodOptional<z.ZodBoolean>;
                icon: z.ZodOptional<z.ZodString>;
                options: z.ZodOptional<
                  z.ZodArray<
                    z.ZodObject<
                      {
                        value: z.ZodString;
                        label: z.ZodString;
                        description: z.ZodOptional<z.ZodString>;
                        icon: z.ZodOptional<z.ZodString>;
                        disabled: z.ZodOptional<z.ZodBoolean>;
                      },
                      z.core.$strip
                    >
                  >
                >;
                pattern: z.ZodOptional<z.ZodString>;
                patternError: z.ZodOptional<z.ZodString>;
                min: z.ZodOptional<z.ZodNumber>;
                max: z.ZodOptional<z.ZodNumber>;
                step: z.ZodOptional<z.ZodNumber>;
                unit: z.ZodOptional<z.ZodString>;
                visible: z.ZodOptional<
                  z.ZodType<
                    {
                      key: string;
                      equals?: unknown;
                      in?: unknown[];
                      notEquals?: unknown;
                    },
                    unknown,
                    z.core.$ZodTypeInternals<
                      {
                        key: string;
                        equals?: unknown;
                        in?: unknown[];
                        notEquals?: unknown;
                      },
                      unknown
                    >
                  >
                >;
              },
              z.core.$strip
            >
          >
        >;
        render: z.ZodObject<
          {
            visible: z.ZodDefault<z.ZodBoolean>;
            pinTo: z.ZodDefault<
              z.ZodArray<
                z.ZodEnum<{
                  "chat-apps-section": "chat-apps-section";
                  "companion-shell": "companion-shell";
                  "settings-integrations": "settings-integrations";
                }>
              >
            >;
            style: z.ZodDefault<
              z.ZodEnum<{
                card: "card";
                "setup-panel": "setup-panel";
                "hero-card": "hero-card";
              }>
            >;
            icon: z.ZodOptional<z.ZodString>;
            heroImage: z.ZodOptional<z.ZodString>;
            group: z.ZodString;
            groupOrder: z.ZodOptional<z.ZodNumber>;
            actions: z.ZodDefault<
              z.ZodArray<
                z.ZodEnum<{
                  install: "install";
                  stop: "stop";
                  uninstall: "uninstall";
                  enable: "enable";
                  configure: "configure";
                  launch: "launch";
                  attach: "attach";
                  detach: "detach";
                  "setup-guide": "setup-guide";
                }>
              >
            >;
          },
          z.core.$strip
        >;
        resources: z.ZodDefault<
          z.ZodObject<
            {
              homepage: z.ZodOptional<z.ZodString>;
              repository: z.ZodOptional<z.ZodString>;
              setupGuideUrl: z.ZodOptional<z.ZodString>;
            },
            z.core.$strip
          >
        >;
        dependsOn: z.ZodDefault<z.ZodArray<z.ZodString>>;
      },
      z.core.$strip
    >,
    z.ZodObject<
      {
        kind: z.ZodLiteral<"connector">;
        subtype: z.ZodEnum<{
          email: "email";
          calendar: "calendar";
          messaging: "messaging";
          social: "social";
          streaming: "streaming";
          other: "other";
        }>;
        auth: z.ZodOptional<
          z.ZodObject<
            {
              kind: z.ZodEnum<{
                none: "none";
                credentials: "credentials";
                oauth: "oauth";
                token: "token";
              }>;
              credentialKeys: z.ZodDefault<z.ZodArray<z.ZodString>>;
            },
            z.core.$strip
          >
        >;
        id: z.ZodString;
        name: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        npmName: z.ZodOptional<z.ZodString>;
        version: z.ZodOptional<z.ZodString>;
        releaseStream: z.ZodOptional<
          z.ZodEnum<{
            latest: "latest";
            beta: "beta";
          }>
        >;
        source: z.ZodDefault<
          z.ZodEnum<{
            store: "store";
            bundled: "bundled";
          }>
        >;
        tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
        config: z.ZodDefault<
          z.ZodRecord<
            z.ZodString,
            z.ZodObject<
              {
                type: z.ZodEnum<{
                  string: "string";
                  number: "number";
                  boolean: "boolean";
                  json: "json";
                  url: "url";
                  select: "select";
                  textarea: "textarea";
                  multiselect: "multiselect";
                  secret: "secret";
                  "file-path": "file-path";
                }>;
                required: z.ZodBoolean;
                sensitive: z.ZodOptional<z.ZodBoolean>;
                default: z.ZodOptional<
                  z.ZodUnion<
                    readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodNull]
                  >
                >;
                label: z.ZodOptional<z.ZodString>;
                help: z.ZodOptional<z.ZodString>;
                placeholder: z.ZodOptional<z.ZodString>;
                group: z.ZodOptional<z.ZodString>;
                order: z.ZodOptional<z.ZodNumber>;
                width: z.ZodOptional<
                  z.ZodEnum<{
                    full: "full";
                    half: "half";
                    third: "third";
                  }>
                >;
                advanced: z.ZodOptional<z.ZodBoolean>;
                hidden: z.ZodOptional<z.ZodBoolean>;
                readonly: z.ZodOptional<z.ZodBoolean>;
                icon: z.ZodOptional<z.ZodString>;
                options: z.ZodOptional<
                  z.ZodArray<
                    z.ZodObject<
                      {
                        value: z.ZodString;
                        label: z.ZodString;
                        description: z.ZodOptional<z.ZodString>;
                        icon: z.ZodOptional<z.ZodString>;
                        disabled: z.ZodOptional<z.ZodBoolean>;
                      },
                      z.core.$strip
                    >
                  >
                >;
                pattern: z.ZodOptional<z.ZodString>;
                patternError: z.ZodOptional<z.ZodString>;
                min: z.ZodOptional<z.ZodNumber>;
                max: z.ZodOptional<z.ZodNumber>;
                step: z.ZodOptional<z.ZodNumber>;
                unit: z.ZodOptional<z.ZodString>;
                visible: z.ZodOptional<
                  z.ZodType<
                    {
                      key: string;
                      equals?: unknown;
                      in?: unknown[];
                      notEquals?: unknown;
                    },
                    unknown,
                    z.core.$ZodTypeInternals<
                      {
                        key: string;
                        equals?: unknown;
                        in?: unknown[];
                        notEquals?: unknown;
                      },
                      unknown
                    >
                  >
                >;
              },
              z.core.$strip
            >
          >
        >;
        render: z.ZodObject<
          {
            visible: z.ZodDefault<z.ZodBoolean>;
            pinTo: z.ZodDefault<
              z.ZodArray<
                z.ZodEnum<{
                  "chat-apps-section": "chat-apps-section";
                  "companion-shell": "companion-shell";
                  "settings-integrations": "settings-integrations";
                }>
              >
            >;
            style: z.ZodDefault<
              z.ZodEnum<{
                card: "card";
                "setup-panel": "setup-panel";
                "hero-card": "hero-card";
              }>
            >;
            icon: z.ZodOptional<z.ZodString>;
            heroImage: z.ZodOptional<z.ZodString>;
            group: z.ZodString;
            groupOrder: z.ZodOptional<z.ZodNumber>;
            actions: z.ZodDefault<
              z.ZodArray<
                z.ZodEnum<{
                  install: "install";
                  stop: "stop";
                  uninstall: "uninstall";
                  enable: "enable";
                  configure: "configure";
                  launch: "launch";
                  attach: "attach";
                  detach: "detach";
                  "setup-guide": "setup-guide";
                }>
              >
            >;
          },
          z.core.$strip
        >;
        resources: z.ZodDefault<
          z.ZodObject<
            {
              homepage: z.ZodOptional<z.ZodString>;
              repository: z.ZodOptional<z.ZodString>;
              setupGuideUrl: z.ZodOptional<z.ZodString>;
            },
            z.core.$strip
          >
        >;
        dependsOn: z.ZodDefault<z.ZodArray<z.ZodString>>;
      },
      z.core.$strip
    >,
    z.ZodObject<
      {
        kind: z.ZodLiteral<"app">;
        subtype: z.ZodEnum<{
          game: "game";
          marketplace: "marketplace";
          tool: "tool";
          shell: "shell";
          other: "other";
          trading: "trading";
        }>;
        launch: z.ZodObject<
          {
            type: z.ZodEnum<{
              "internal-tab": "internal-tab";
              overlay: "overlay";
              "server-launch": "server-launch";
            }>;
            target: z.ZodOptional<z.ZodString>;
            url: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            viewer: z.ZodOptional<
              z.ZodObject<
                {
                  url: z.ZodString;
                  embedParams: z.ZodOptional<
                    z.ZodRecord<z.ZodString, z.ZodString>
                  >;
                  postMessageAuth: z.ZodOptional<z.ZodBoolean>;
                  sandbox: z.ZodOptional<z.ZodString>;
                },
                z.core.$strip
              >
            >;
            session: z.ZodOptional<
              z.ZodObject<
                {
                  mode: z.ZodEnum<{
                    external: "external";
                    viewer: "viewer";
                    "spectate-and-steer": "spectate-and-steer";
                  }>;
                  features: z.ZodOptional<
                    z.ZodArray<
                      z.ZodEnum<{
                        pause: "pause";
                        resume: "resume";
                        telemetry: "telemetry";
                        commands: "commands";
                        suggestions: "suggestions";
                      }>
                    >
                  >;
                },
                z.core.$strip
              >
            >;
            supports: z.ZodOptional<
              z.ZodObject<
                {
                  v0: z.ZodBoolean;
                  v1: z.ZodBoolean;
                  v2: z.ZodBoolean;
                },
                z.core.$strip
              >
            >;
            npm: z.ZodOptional<
              z.ZodObject<
                {
                  package: z.ZodString;
                  v0Version: z.ZodNullable<z.ZodString>;
                  v1Version: z.ZodNullable<z.ZodString>;
                  v2Version: z.ZodNullable<z.ZodString>;
                },
                z.core.$strip
              >
            >;
            capabilities: z.ZodDefault<z.ZodArray<z.ZodString>>;
            uiExtension: z.ZodOptional<
              z.ZodObject<
                {
                  detailPanelId: z.ZodString;
                },
                z.core.$strip
              >
            >;
            curatedSlug: z.ZodOptional<z.ZodString>;
            routePlugin: z.ZodOptional<
              z.ZodObject<
                {
                  specifier: z.ZodString;
                  exportName: z.ZodOptional<z.ZodString>;
                },
                z.core.$strip
              >
            >;
            mainTab: z.ZodOptional<z.ZodBoolean>;
          },
          z.core.$strip
        >;
        id: z.ZodString;
        name: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        npmName: z.ZodOptional<z.ZodString>;
        version: z.ZodOptional<z.ZodString>;
        releaseStream: z.ZodOptional<
          z.ZodEnum<{
            latest: "latest";
            beta: "beta";
          }>
        >;
        source: z.ZodDefault<
          z.ZodEnum<{
            store: "store";
            bundled: "bundled";
          }>
        >;
        tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
        config: z.ZodDefault<
          z.ZodRecord<
            z.ZodString,
            z.ZodObject<
              {
                type: z.ZodEnum<{
                  string: "string";
                  number: "number";
                  boolean: "boolean";
                  json: "json";
                  url: "url";
                  select: "select";
                  textarea: "textarea";
                  multiselect: "multiselect";
                  secret: "secret";
                  "file-path": "file-path";
                }>;
                required: z.ZodBoolean;
                sensitive: z.ZodOptional<z.ZodBoolean>;
                default: z.ZodOptional<
                  z.ZodUnion<
                    readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodNull]
                  >
                >;
                label: z.ZodOptional<z.ZodString>;
                help: z.ZodOptional<z.ZodString>;
                placeholder: z.ZodOptional<z.ZodString>;
                group: z.ZodOptional<z.ZodString>;
                order: z.ZodOptional<z.ZodNumber>;
                width: z.ZodOptional<
                  z.ZodEnum<{
                    full: "full";
                    half: "half";
                    third: "third";
                  }>
                >;
                advanced: z.ZodOptional<z.ZodBoolean>;
                hidden: z.ZodOptional<z.ZodBoolean>;
                readonly: z.ZodOptional<z.ZodBoolean>;
                icon: z.ZodOptional<z.ZodString>;
                options: z.ZodOptional<
                  z.ZodArray<
                    z.ZodObject<
                      {
                        value: z.ZodString;
                        label: z.ZodString;
                        description: z.ZodOptional<z.ZodString>;
                        icon: z.ZodOptional<z.ZodString>;
                        disabled: z.ZodOptional<z.ZodBoolean>;
                      },
                      z.core.$strip
                    >
                  >
                >;
                pattern: z.ZodOptional<z.ZodString>;
                patternError: z.ZodOptional<z.ZodString>;
                min: z.ZodOptional<z.ZodNumber>;
                max: z.ZodOptional<z.ZodNumber>;
                step: z.ZodOptional<z.ZodNumber>;
                unit: z.ZodOptional<z.ZodString>;
                visible: z.ZodOptional<
                  z.ZodType<
                    {
                      key: string;
                      equals?: unknown;
                      in?: unknown[];
                      notEquals?: unknown;
                    },
                    unknown,
                    z.core.$ZodTypeInternals<
                      {
                        key: string;
                        equals?: unknown;
                        in?: unknown[];
                        notEquals?: unknown;
                      },
                      unknown
                    >
                  >
                >;
              },
              z.core.$strip
            >
          >
        >;
        render: z.ZodObject<
          {
            visible: z.ZodDefault<z.ZodBoolean>;
            pinTo: z.ZodDefault<
              z.ZodArray<
                z.ZodEnum<{
                  "chat-apps-section": "chat-apps-section";
                  "companion-shell": "companion-shell";
                  "settings-integrations": "settings-integrations";
                }>
              >
            >;
            style: z.ZodDefault<
              z.ZodEnum<{
                card: "card";
                "setup-panel": "setup-panel";
                "hero-card": "hero-card";
              }>
            >;
            icon: z.ZodOptional<z.ZodString>;
            heroImage: z.ZodOptional<z.ZodString>;
            group: z.ZodString;
            groupOrder: z.ZodOptional<z.ZodNumber>;
            actions: z.ZodDefault<
              z.ZodArray<
                z.ZodEnum<{
                  install: "install";
                  stop: "stop";
                  uninstall: "uninstall";
                  enable: "enable";
                  configure: "configure";
                  launch: "launch";
                  attach: "attach";
                  detach: "detach";
                  "setup-guide": "setup-guide";
                }>
              >
            >;
          },
          z.core.$strip
        >;
        resources: z.ZodDefault<
          z.ZodObject<
            {
              homepage: z.ZodOptional<z.ZodString>;
              repository: z.ZodOptional<z.ZodString>;
              setupGuideUrl: z.ZodOptional<z.ZodString>;
            },
            z.core.$strip
          >
        >;
        dependsOn: z.ZodDefault<z.ZodArray<z.ZodString>>;
      },
      z.core.$strip
    >,
  ],
  "kind"
>;
export type PluginEntry = z.infer<typeof pluginEntrySchema>;
export type ConnectorEntry = z.infer<typeof connectorEntrySchema>;
export type AppEntry = z.infer<typeof appEntrySchema>;
export type RegistryEntry = z.infer<typeof registryEntrySchema>;
export type RegistryKind = RegistryEntry["kind"];
export declare const registryRuntimeOverlaySchema: z.ZodObject<
  {
    id: z.ZodString;
    enabled: z.ZodBoolean;
    configured: z.ZodBoolean;
    isActive: z.ZodBoolean;
    loadError: z.ZodOptional<z.ZodString>;
    validationErrors: z.ZodDefault<
      z.ZodArray<
        z.ZodObject<
          {
            field: z.ZodString;
            message: z.ZodString;
          },
          z.core.$strip
        >
      >
    >;
    validationWarnings: z.ZodDefault<
      z.ZodArray<
        z.ZodObject<
          {
            field: z.ZodString;
            message: z.ZodString;
          },
          z.core.$strip
        >
      >
    >;
    installedVersion: z.ZodOptional<z.ZodString>;
    latestVersion: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  },
  z.core.$strip
>;
export type RegistryRuntimeOverlay = z.infer<
  typeof registryRuntimeOverlaySchema
>;
export type RegistryView = RegistryEntry & RegistryRuntimeOverlay;
//# sourceMappingURL=schema.d.ts.map
