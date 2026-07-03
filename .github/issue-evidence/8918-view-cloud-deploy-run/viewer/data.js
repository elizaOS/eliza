window.SCENARIO_RUN_DATA = {
  schema: "eliza_scenario_run_viewer_v1",
  generatedAt: "2026-06-23T14:25:08.038Z",
  runDir:
    "/Users/shawwalters/eliza-workspace/eliza/eliza/.github/issue-evidence/8918-view-cloud-deploy-run",
  matrixPath:
    "/Users/shawwalters/eliza-workspace/eliza/eliza/.github/issue-evidence/8918-view-cloud-deploy-run/matrix.json",
  nativeJsonlPath: null,
  nativeManifestPath: null,
  report: {
    runId: "9c080a03-1523-43a4-bd4b-09afa36168ae",
    startedAtIso: "2026-06-23T14:24:59.124Z",
    completedAtIso: "2026-06-23T14:25:08.037Z",
    providerName: "deterministic-llm-proxy",
    scenarios: [
      {
        id: "orchestrator-view-cloud-deploy",
        title:
          "Cloud-targeted view-plugin guidance records apps.create and viewKind",
        domain: "agent-orchestrator",
        tags: [
          "orchestrator",
          "view-plugin",
          "cloud",
          "apps.create",
          "viewKind",
          "pr",
          "deterministic",
        ],
        status: "passed",
        durationMs: 37,
        turns: [
          {
            name: "run cloud-targeted view plugin deploy guidance against mock cloud",
            kind: "action",
            text: "Exercise cloud-targeted view plugin deployment guidance.",
            responseText:
              "cloud:mock registered the view plugin with apps.create, release viewKind, Cloud CDN bundleUrl, and affiliate header",
            actionsCalled: [
              {
                actionName: "ORCHESTRATOR_VIEW_CLOUD_DEPLOY",
                parameters: {},
                result: {
                  success: true,
                  data: {
                    summary:
                      "cloud:mock registered the view plugin with apps.create, release viewKind, Cloud CDN bundleUrl, and affiliate header",
                    taskIds: [],
                    sessionIds: [],
                    events: [],
                    finalStatuses: {},
                    guidance:
                      "Build a view plugin for Weather Panel.\nThe plugin source directory is /workspace/plugins/plugin-weather-panel. It has already been scaffolded.\nTarget cloud deployment with viewKind release and affiliate code aff_8918.\n\n--- View Plugin Deployment (Eliza Cloud) ---\nThis task builds an elizaOS view/plugin for Eliza Cloud. It must be published as an installable Cloud app, not left as local-only files.\n- Work from the plugin source directory `/workspace/plugins/plugin-weather-panel`; do not assume files outside that tree exist in the Cloud sandbox.\n- Build the view bundle (`bun run build:views`, package `build`, or the repo-local equivalent) and verify the exported component named by `Plugin.views.componentExport` loads.\n- Publish the built bundle/assets to the Cloud app/container artifact flow so the view receives a Cloud CDN URL.\n- Call `apps.create` to register the installable Cloud app; keep the returned `appId`/slug and use follow-up app update APIs for manifest, domain, and monetization metadata.\n- Set an explicit `viewKind` (`release`, `preview`, `developer`, or `system`) in the published manifest for every view. Do not rely on legacy `developerOnly` or an implicit default.\n- Update `Plugin.views` so each Cloud-published view keeps the correct `id`, `path`, `viewType`, `componentExport`, and Cloud CDN `bundleUrl`.\n- If the view calls monetized Cloud APIs or chat endpoints, forward the user's affiliate value with `X-Affiliate-Code` when one is provided. Never hardcode an owner API key in frontend code.\n- Cloud app sandboxes are isolated and ephemeral: local agent-workspace files, `localhost`, and unuploaded build outputs will not exist after deploy. Upload/publish every runtime asset the view needs.\n- Verify the real deployed artifact before reporting done: confirm the app registration exists, the manifest contains `viewKind`, and the Cloud CDN bundle or live Cloud URL loads.",
                    cloudMock: {
                      calls: [
                        {
                          command: "apps.create",
                          headers: { "X-Affiliate-Code": "aff_8918" },
                          body: {
                            slug: "weather-panel",
                            sourceDir:
                              "/workspace/plugins/plugin-weather-panel",
                            manifest: {
                              name: "@scenario/plugin-weather-panel",
                              viewKind: "release",
                              views: [
                                {
                                  id: "weather-panel",
                                  path: "/apps/weather-panel",
                                  viewType: "gui",
                                  componentExport: "WeatherPanelView",
                                  viewKind: "release",
                                  bundleUrl:
                                    "https://cdn.eliza.cloud/apps/weather-panel/weather-panel.js",
                                },
                              ],
                            },
                          },
                        },
                      ],
                      manifest: {
                        name: "@scenario/plugin-weather-panel",
                        viewKind: "release",
                        views: [
                          {
                            id: "weather-panel",
                            path: "/apps/weather-panel",
                            viewType: "gui",
                            componentExport: "WeatherPanelView",
                            viewKind: "release",
                            bundleUrl:
                              "https://cdn.eliza.cloud/apps/weather-panel/weather-panel.js",
                          },
                        ],
                      },
                    },
                    digest:
                      "apps.create slug=weather-panel viewKind=release bundleUrl=https://cdn.eliza.cloud/apps/weather-panel/weather-panel.js X-Affiliate-Code=aff_8918",
                  },
                  text: "cloud:mock registered the view plugin with apps.create, release viewKind, Cloud CDN bundleUrl, and affiliate header",
                  raw: {
                    success: true,
                    text: "cloud:mock registered the view plugin with apps.create, release viewKind, Cloud CDN bundleUrl, and affiliate header",
                    userFacingText:
                      "cloud:mock registered the view plugin with apps.create, release viewKind, Cloud CDN bundleUrl, and affiliate header",
                    verifiedUserFacing: true,
                    data: {
                      summary:
                        "cloud:mock registered the view plugin with apps.create, release viewKind, Cloud CDN bundleUrl, and affiliate header",
                      taskIds: [],
                      sessionIds: [],
                      events: [],
                      finalStatuses: {},
                      guidance:
                        "Build a view plugin for Weather Panel.\nThe plugin source directory is /workspace/plugins/plugin-weather-panel. It has already been scaffolded.\nTarget cloud deployment with viewKind release and affiliate code aff_8918.\n\n--- View Plugin Deployment (Eliza Cloud) ---\nThis task builds an elizaOS view/plugin for Eliza Cloud. It must be published as an installable Cloud app, not left as local-only files.\n- Work from the plugin source directory `/workspace/plugins/plugin-weather-panel`; do not assume files outside that tree exist in the Cloud sandbox.\n- Build the view bundle (`bun run build:views`, package `build`, or the repo-local equivalent) and verify the exported component named by `Plugin.views.componentExport` loads.\n- Publish the built bundle/assets to the Cloud app/container artifact flow so the view receives a Cloud CDN URL.\n- Call `apps.create` to register the installable Cloud app; keep the returned `appId`/slug and use follow-up app update APIs for manifest, domain, and monetization metadata.\n- Set an explicit `viewKind` (`release`, `preview`, `developer`, or `system`) in the published manifest for every view. Do not rely on legacy `developerOnly` or an implicit default.\n- Update `Plugin.views` so each Cloud-published view keeps the correct `id`, `path`, `viewType`, `componentExport`, and Cloud CDN `bundleUrl`.\n- If the view calls monetized Cloud APIs or chat endpoints, forward the user's affiliate value with `X-Affiliate-Code` when one is provided. Never hardcode an owner API key in frontend code.\n- Cloud app sandboxes are isolated and ephemeral: local agent-workspace files, `localhost`, and unuploaded build outputs will not exist after deploy. Upload/publish every runtime asset the view needs.\n- Verify the real deployed artifact before reporting done: confirm the app registration exists, the manifest contains `viewKind`, and the Cloud CDN bundle or live Cloud URL loads.",
                      cloudMock: {
                        calls: [
                          {
                            command: "apps.create",
                            headers: { "X-Affiliate-Code": "aff_8918" },
                            body: {
                              slug: "weather-panel",
                              sourceDir:
                                "/workspace/plugins/plugin-weather-panel",
                              manifest: {
                                name: "@scenario/plugin-weather-panel",
                                viewKind: "release",
                                views: [
                                  {
                                    id: "weather-panel",
                                    path: "/apps/weather-panel",
                                    viewType: "gui",
                                    componentExport: "WeatherPanelView",
                                    viewKind: "release",
                                    bundleUrl:
                                      "https://cdn.eliza.cloud/apps/weather-panel/weather-panel.js",
                                  },
                                ],
                              },
                            },
                          },
                        ],
                        manifest: {
                          name: "@scenario/plugin-weather-panel",
                          viewKind: "release",
                          views: [
                            {
                              id: "weather-panel",
                              path: "/apps/weather-panel",
                              viewType: "gui",
                              componentExport: "WeatherPanelView",
                              viewKind: "release",
                              bundleUrl:
                                "https://cdn.eliza.cloud/apps/weather-panel/weather-panel.js",
                            },
                          ],
                        },
                      },
                      digest:
                        "apps.create slug=weather-panel viewKind=release bundleUrl=https://cdn.eliza.cloud/apps/weather-panel/weather-panel.js X-Affiliate-Code=aff_8918",
                    },
                  },
                },
              },
            ],
            durationMs: 1,
            failedAssertions: [],
          },
        ],
        finalChecks: [
          {
            label: "actionCalled",
            type: "actionCalled",
            status: "passed",
            detail: "ORCHESTRATOR_VIEW_CLOUD_DEPLOY called 1x",
          },
          {
            label: "mock cloud recorded apps.create with viewKind manifest",
            type: "custom",
            status: "passed",
            detail: "predicate returned undefined",
          },
        ],
        actionsCalled: [
          {
            actionName: "ORCHESTRATOR_VIEW_CLOUD_DEPLOY",
            parameters: {},
            result: {
              success: true,
              data: {
                summary:
                  "cloud:mock registered the view plugin with apps.create, release viewKind, Cloud CDN bundleUrl, and affiliate header",
                taskIds: [],
                sessionIds: [],
                events: [],
                finalStatuses: {},
                guidance:
                  "Build a view plugin for Weather Panel.\nThe plugin source directory is /workspace/plugins/plugin-weather-panel. It has already been scaffolded.\nTarget cloud deployment with viewKind release and affiliate code aff_8918.\n\n--- View Plugin Deployment (Eliza Cloud) ---\nThis task builds an elizaOS view/plugin for Eliza Cloud. It must be published as an installable Cloud app, not left as local-only files.\n- Work from the plugin source directory `/workspace/plugins/plugin-weather-panel`; do not assume files outside that tree exist in the Cloud sandbox.\n- Build the view bundle (`bun run build:views`, package `build`, or the repo-local equivalent) and verify the exported component named by `Plugin.views.componentExport` loads.\n- Publish the built bundle/assets to the Cloud app/container artifact flow so the view receives a Cloud CDN URL.\n- Call `apps.create` to register the installable Cloud app; keep the returned `appId`/slug and use follow-up app update APIs for manifest, domain, and monetization metadata.\n- Set an explicit `viewKind` (`release`, `preview`, `developer`, or `system`) in the published manifest for every view. Do not rely on legacy `developerOnly` or an implicit default.\n- Update `Plugin.views` so each Cloud-published view keeps the correct `id`, `path`, `viewType`, `componentExport`, and Cloud CDN `bundleUrl`.\n- If the view calls monetized Cloud APIs or chat endpoints, forward the user's affiliate value with `X-Affiliate-Code` when one is provided. Never hardcode an owner API key in frontend code.\n- Cloud app sandboxes are isolated and ephemeral: local agent-workspace files, `localhost`, and unuploaded build outputs will not exist after deploy. Upload/publish every runtime asset the view needs.\n- Verify the real deployed artifact before reporting done: confirm the app registration exists, the manifest contains `viewKind`, and the Cloud CDN bundle or live Cloud URL loads.",
                cloudMock: {
                  calls: [
                    {
                      command: "apps.create",
                      headers: { "X-Affiliate-Code": "aff_8918" },
                      body: {
                        slug: "weather-panel",
                        sourceDir: "/workspace/plugins/plugin-weather-panel",
                        manifest: {
                          name: "@scenario/plugin-weather-panel",
                          viewKind: "release",
                          views: [
                            {
                              id: "weather-panel",
                              path: "/apps/weather-panel",
                              viewType: "gui",
                              componentExport: "WeatherPanelView",
                              viewKind: "release",
                              bundleUrl:
                                "https://cdn.eliza.cloud/apps/weather-panel/weather-panel.js",
                            },
                          ],
                        },
                      },
                    },
                  ],
                  manifest: {
                    name: "@scenario/plugin-weather-panel",
                    viewKind: "release",
                    views: [
                      {
                        id: "weather-panel",
                        path: "/apps/weather-panel",
                        viewType: "gui",
                        componentExport: "WeatherPanelView",
                        viewKind: "release",
                        bundleUrl:
                          "https://cdn.eliza.cloud/apps/weather-panel/weather-panel.js",
                      },
                    ],
                  },
                },
                digest:
                  "apps.create slug=weather-panel viewKind=release bundleUrl=https://cdn.eliza.cloud/apps/weather-panel/weather-panel.js X-Affiliate-Code=aff_8918",
              },
              text: "cloud:mock registered the view plugin with apps.create, release viewKind, Cloud CDN bundleUrl, and affiliate header",
              raw: {
                success: true,
                text: "cloud:mock registered the view plugin with apps.create, release viewKind, Cloud CDN bundleUrl, and affiliate header",
                userFacingText:
                  "cloud:mock registered the view plugin with apps.create, release viewKind, Cloud CDN bundleUrl, and affiliate header",
                verifiedUserFacing: true,
                data: {
                  summary:
                    "cloud:mock registered the view plugin with apps.create, release viewKind, Cloud CDN bundleUrl, and affiliate header",
                  taskIds: [],
                  sessionIds: [],
                  events: [],
                  finalStatuses: {},
                  guidance:
                    "Build a view plugin for Weather Panel.\nThe plugin source directory is /workspace/plugins/plugin-weather-panel. It has already been scaffolded.\nTarget cloud deployment with viewKind release and affiliate code aff_8918.\n\n--- View Plugin Deployment (Eliza Cloud) ---\nThis task builds an elizaOS view/plugin for Eliza Cloud. It must be published as an installable Cloud app, not left as local-only files.\n- Work from the plugin source directory `/workspace/plugins/plugin-weather-panel`; do not assume files outside that tree exist in the Cloud sandbox.\n- Build the view bundle (`bun run build:views`, package `build`, or the repo-local equivalent) and verify the exported component named by `Plugin.views.componentExport` loads.\n- Publish the built bundle/assets to the Cloud app/container artifact flow so the view receives a Cloud CDN URL.\n- Call `apps.create` to register the installable Cloud app; keep the returned `appId`/slug and use follow-up app update APIs for manifest, domain, and monetization metadata.\n- Set an explicit `viewKind` (`release`, `preview`, `developer`, or `system`) in the published manifest for every view. Do not rely on legacy `developerOnly` or an implicit default.\n- Update `Plugin.views` so each Cloud-published view keeps the correct `id`, `path`, `viewType`, `componentExport`, and Cloud CDN `bundleUrl`.\n- If the view calls monetized Cloud APIs or chat endpoints, forward the user's affiliate value with `X-Affiliate-Code` when one is provided. Never hardcode an owner API key in frontend code.\n- Cloud app sandboxes are isolated and ephemeral: local agent-workspace files, `localhost`, and unuploaded build outputs will not exist after deploy. Upload/publish every runtime asset the view needs.\n- Verify the real deployed artifact before reporting done: confirm the app registration exists, the manifest contains `viewKind`, and the Cloud CDN bundle or live Cloud URL loads.",
                  cloudMock: {
                    calls: [
                      {
                        command: "apps.create",
                        headers: { "X-Affiliate-Code": "aff_8918" },
                        body: {
                          slug: "weather-panel",
                          sourceDir: "/workspace/plugins/plugin-weather-panel",
                          manifest: {
                            name: "@scenario/plugin-weather-panel",
                            viewKind: "release",
                            views: [
                              {
                                id: "weather-panel",
                                path: "/apps/weather-panel",
                                viewType: "gui",
                                componentExport: "WeatherPanelView",
                                viewKind: "release",
                                bundleUrl:
                                  "https://cdn.eliza.cloud/apps/weather-panel/weather-panel.js",
                              },
                            ],
                          },
                        },
                      },
                    ],
                    manifest: {
                      name: "@scenario/plugin-weather-panel",
                      viewKind: "release",
                      views: [
                        {
                          id: "weather-panel",
                          path: "/apps/weather-panel",
                          viewType: "gui",
                          componentExport: "WeatherPanelView",
                          viewKind: "release",
                          bundleUrl:
                            "https://cdn.eliza.cloud/apps/weather-panel/weather-panel.js",
                        },
                      ],
                    },
                  },
                  digest:
                    "apps.create slug=weather-panel viewKind=release bundleUrl=https://cdn.eliza.cloud/apps/weather-panel/weather-panel.js X-Affiliate-Code=aff_8918",
                },
              },
            },
          },
        ],
        failedAssertions: [],
        providerName: "deterministic-llm-proxy",
      },
    ],
    totals: { passed: 1, failed: 0, skipped: 0, flakyPassed: 0, costUsd: 0 },
    totalCount: 1,
    passedCount: 1,
    failedCount: 0,
    skippedCount: 0,
    flakyPassedCount: 0,
    totalCostUsd: 0,
    artifactPaths: {
      runDir:
        "/Users/shawwalters/eliza-workspace/eliza/eliza/.github/issue-evidence/8918-view-cloud-deploy-run",
      matrixJson:
        "/Users/shawwalters/eliza-workspace/eliza/eliza/.github/issue-evidence/8918-view-cloud-deploy-run/matrix.json",
      viewerIndex:
        "/Users/shawwalters/eliza-workspace/eliza/eliza/.github/issue-evidence/8918-view-cloud-deploy-run/viewer/index.html",
      viewerData:
        "/Users/shawwalters/eliza-workspace/eliza/eliza/.github/issue-evidence/8918-view-cloud-deploy-run/viewer/data.js",
    },
  },
  trajectories: {
    root: "/Users/shawwalters/eliza-workspace/eliza/eliza/.github/issue-evidence/8918-view-cloud-deploy-run/trajectories",
    files: [],
    summaries: [],
  },
  nativeExport: { manifest: null, rows: [] },
};
