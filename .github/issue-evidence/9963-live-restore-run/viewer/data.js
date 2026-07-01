window.SCENARIO_RUN_DATA = {
  schema: "eliza_scenario_run_viewer_v1",
  generatedAt: "2026-06-30T07:05:25.882Z",
  runDir:
    "/Users/shawwalters/.codex/worktrees/5612/eliza/.github/issue-evidence/9963-live-restore-run",
  matrixPath:
    "/Users/shawwalters/.codex/worktrees/5612/eliza/.github/issue-evidence/9963-live-restore-run/matrix.json",
  nativeJsonlPath:
    "/Users/shawwalters/.codex/worktrees/5612/eliza/.github/issue-evidence/9963-live-restore-native.jsonl",
  nativeManifestPath:
    "/Users/shawwalters/.codex/worktrees/5612/eliza/.github/issue-evidence/9963-live-restore-native.manifest.json",
  report: {
    runId: "f39e297f-e254-4579-92c9-e8ae7a329865",
    startedAtIso: "2026-06-30T07:05:19.753Z",
    completedAtIso: "2026-06-30T07:05:25.879Z",
    providerName: "openai",
    scenarios: [
      {
        id: "backup.restore-recall",
        title: "Agent recalls a restored memory after local backup restore",
        domain: "backup",
        tags: ["backup", "restore", "live-model", "issue-9963"],
        status: "failed",
        durationMs: 890,
        turns: [
          {
            name: "ask-restored-recall-phrase",
            kind: "message",
            text: "Before this restore, I gave you a backup recall phrase. What exact three-word phrase did I ask you to remember? Reply with only that phrase.",
            responseText: "",
            actionsCalled: [],
            durationMs: 874,
            failedAssertions: [
              'responseIncludesAll: expected response to include all of [silver,comet,orchid], missing [silver,comet,orchid], saw ""',
            ],
          },
        ],
        finalChecks: [
          {
            label: "actionCalled",
            type: "actionCalled",
            status: "failed",
            detail: "expected 1 call(s) to REPLY, saw 0. Called: (none)",
          },
        ],
        actionsCalled: [],
        failedAssertions: [
          {
            label: "ask-restored-recall-phrase",
            detail:
              'responseIncludesAll: expected response to include all of [silver,comet,orchid], missing [silver,comet,orchid], saw ""',
          },
          {
            label: "actionCalled",
            detail: "expected 1 call(s) to REPLY, saw 0. Called: (none)",
          },
        ],
        providerName: "openai",
      },
    ],
    totals: { passed: 0, failed: 1, skipped: 0, flakyPassed: 0, costUsd: 0 },
    totalCount: 1,
    passedCount: 0,
    failedCount: 1,
    skippedCount: 0,
    flakyPassedCount: 0,
    totalCostUsd: 0,
    artifactPaths: {
      runDir:
        "/Users/shawwalters/.codex/worktrees/5612/eliza/.github/issue-evidence/9963-live-restore-run",
      matrixJson:
        "/Users/shawwalters/.codex/worktrees/5612/eliza/.github/issue-evidence/9963-live-restore-run/matrix.json",
      viewerIndex:
        "/Users/shawwalters/.codex/worktrees/5612/eliza/.github/issue-evidence/9963-live-restore-run/viewer/index.html",
      viewerData:
        "/Users/shawwalters/.codex/worktrees/5612/eliza/.github/issue-evidence/9963-live-restore-run/viewer/data.js",
      nativeJsonl:
        "/Users/shawwalters/.codex/worktrees/5612/eliza/.github/issue-evidence/9963-live-restore-native.jsonl",
      nativeManifest:
        "/Users/shawwalters/.codex/worktrees/5612/eliza/.github/issue-evidence/9963-live-restore-native.manifest.json",
    },
  },
  trajectories: {
    root: "/Users/shawwalters/.codex/worktrees/5612/eliza/.github/issue-evidence/9963-live-restore-run/trajectories",
    files: [
      {
        path: "trajectories/546ac3ab-0468-01a2-9d5b-52dfa34bf9cc/tj-58d2f3319ed89d.json",
        payload: {
          trajectoryId: "tj-58d2f3319ed89d",
          agentId: "546ac3ab-0468-01a2-9d5b-52dfa34bf9cc",
          roomId: "55d86625-bd07-05ca-a220-da33316b9a26",
          runId: "f39e297f-e254-4579-92c9-e8ae7a329865",
          scenarioId: "backup.restore-recall",
          rootMessage: {
            id: "b19d1c04-f133-4da2-b1ad-4210c41dcac7",
            text: "Before this restore, I gave you a backup recall phrase. What exact three-word phrase did I ask you to remember? Reply with only that phrase.",
            sender: "132dfa32-60b3-0e8d-8339-1e6adde36049",
          },
          startedAt: 1782803124979,
          status: "finished",
          stages: [
            {
              stageId: "stage-msghandler-1782803124979",
              kind: "messageHandler",
              startedAt: 1782803124979,
              endedAt: 1782803125052,
              latencyMs: 73,
              model: {
                modelType: "RESPONSE_HANDLER",
                provider: "default",
                messages: [
                  {
                    role: "system",
                    content:
                      'user_role: OWNER\n\nprior_dialogue_policy: Prior chat is context only. For current, latest, live, filesystem, runtime, build, deploy, or verification requests, use the current turn\'s tools/context instead of answering from prior tool results or stale sub-agent transcripts.\n\nmessage_handler_stage:\ntask: Plan this direct message.\n\navailable_contexts:\n- simple [label=Simple; aliases=direct,shortcut; sensitivity=public; cache=global]\n- general [label=General; aliases=chat,conversation; sensitivity=public; cache=global]\n- memory [label=Memory; role>=USER; sensitivity=personal; cache=agent]\n- documents [label=Documents; role>=USER; sensitivity=personal; cache=agent]\n- knowledge [label=Knowledge; parent=documents; role>=USER; sensitivity=personal; cache=agent]\n- research [label=Research; parent=documents; role>=USER; sensitivity=personal; cache=conversation]\n- web [label=Web; role>=USER; sensitivity=public; cache=turn]\n- browser [label=Browser; parent=web; role>=ADMIN; sensitivity=personal; cache=turn]\n- code [label=Code; role>=ADMIN; sensitivity=personal; cache=conversation]\n- files [label=Files; parent=code; role>=ADMIN; sensitivity=private; cache=turn]\n- terminal [label=Terminal; parent=code; role>=OWNER; sensitivity=private; cache=turn]\n- email [label=Email; role>=ADMIN; sensitivity=private; cache=turn]\n- calendar [label=Calendar; role>=ADMIN; sensitivity=private; cache=turn]\n- contacts [label=Contacts; role>=ADMIN; sensitivity=private; cache=agent]\n- tasks [label=Tasks; role>=ADMIN; sensitivity=personal; cache=agent]\n- todos [label=Todos; parent=tasks; role>=ADMIN; sensitivity=personal; cache=agent]\n- productivity [label=Productivity; parent=tasks; role>=ADMIN; sensitivity=personal; cache=conversation]\n- health [label=Health; role>=OWNER; sensitivity=private; cache=turn]\n- screen_time [label=Screen Time; aliases=screen_time,screentime; role>=OWNER; sensitivity=private; cache=turn]\n- subscriptions [label=Subscriptions; role>=OWNER; sensitivity=private; cache=turn]\n- finance [label=Finance; aliases=money,balance,balances,portfolio; role>=OWNER; sensitivity=private; cache=turn]\n- payments [label=Payments; parent=finance; role>=OWNER; sensitivity=private; cache=turn]\n- wallet [label=Wallet; aliases=account_balance,wallet_balance; parents=finance; role>=OWNER; sensitivity=private; cache=turn]\n- crypto [label=Crypto; aliases=web3,defi,token,tokens,onchain,on_chain; parents=finance,wallet; role>=OWNER; sensitivity=private; cache=turn]\n- messaging [label=Messaging; role>=ADMIN; sensitivity=private; cache=turn]\n- phone [label=Phone; aliases=sms,voice; parent=messaging; role>=ADMIN; sensitivity=private; cache=turn]\n- social_posting [label=Social Posting; aliases=social_posting,posting; role>=ADMIN; sensitivity=private; cache=turn]\n- social [label=Social; aliases=social_media,social_media; parents=messaging,social_posting; role>=ADMIN; sensitivity=private; cache=turn]\n- media [label=Media; role>=USER; sensitivity=personal; cache=turn]\n- automation [label=Automation; role>=ADMIN; sensitivity=personal; cache=agent]\n- connectors [label=Connectors; role>=ADMIN; sensitivity=private; cache=agent]\n- settings [label=Settings; role>=ADMIN; sensitivity=private; cache=agent]\n- character [label=Character; parent=settings; role>=ADMIN; sensitivity=private; cache=agent]\n- secrets [label=Secrets; role>=OWNER; sensitivity=system; cache=none]\n- admin [label=Admin; role>=OWNER; sensitivity=system; cache=none]\n- system [label=System; parent=admin; role>=OWNER; sensitivity=system; cache=none]\n- state [label=State; parent=system; role>=ADMIN; sensitivity=system; cache=turn]\n- world [label=World; parent=system; role>=ADMIN; sensitivity=private; cache=turn]\n- game [label=Game; parent=world; role>=USER; sensitivity=personal; cache=turn]\n- agent_internal [label=Agent Internal; aliases=internal,self; role>=OWNER; sensitivity=system; cache=none]\n\ndirect/private rules:\n- Ordinary chat, static knowledge, creative writing, rewriting, translation, brainstorming, and short explanations: use contexts=["simple"] and put the final answer in replyText.\n- For simple requests, replyText is the natural user-facing answer; avoid single-token fragments or placeholders unless the user asked for terse.\n- Use non-simple context/action names only for tools, live facts, private state, files, web, shell, side effects, scheduling, memory, settings, secrets, wallet/finance, media, or device/app control.\n- Only use "simple" when you can answer directly from your static knowledge or the visible prior_message / reply_reference context. If a specific name/thing is unclear, choose general or memory.\n- Never claim searched/scanned/recalled unless tool returned it; includes "I scanned the chat" or "Spawning a sub-agent".\n- Crisis/legal/medical/self-harm/police/CPS: contexts=["simple"], replyText deferral only; no actions or conceal/evasion/testimony/contraband advice. Refer to lawyer/emergency services/poison control/doctor/therapist/crisis/DV hotline.\n- For tool/planning paths, replyText is only a brief ack ("On it."). Never refuse because tools may run after this stage.\n- If schema omits shouldRespond, do not invent it.\n- contexts must be ids from available_contexts. If a needed tool context is unclear, use ["general"].\n\nReturn exactly one JSON object for HANDLE_RESPONSE. No prose, markdown, or thinking.\n\n- For code snippets, prefer valid runnable syntax over impossible formatting constraints.\n\n## Response Handler Fields\nPopulate every registered field. Use empty value when not applicable.\n### contexts\nRouting tags. Pick from available_contexts. Use ["simple"] only for trivial direct replies needing no action/tool/provider/sub-agent; replyText is answer. Otherwise choose relevant context ids; planner engages providers/actions. Empty invalid when shouldRespond=RESPOND.\n\n### intents\nShort verb phrases for this turn: ["schedule meeting", "draft email", "research X"]. Use 1-4. Helps action retrieval/routing. Empty for no actionable intent.\n\n### replyText\nUser-facing reply. Populate when shouldRespond=RESPOND. contexts includes "simple" => whole answer. Planning/tool path => brief ack only ("On it.", "Spawning the sub-agent now.", "Looking into it."); planner sends grounded follow-up. IGNORE => empty. No thinking/reasoning.\n\nNEVER refuse in replyText on planning path. If `contexts` or `candidateActionNames` != "simple", planner handles work; ack only, no capability gatekeeping. Ban refusal openings: "I cannot...", "I am unable to...", "I don\'t have the ability to...", "Sorry, I can\'t...". Tools exist (FILE, BASH, TASKS_SPAWN_AGENT, etc.). If no tool can attempt, use shouldRespond=RESPOND, `contexts: ["simple"]`, explain.\n\n### threadOps\nThread operations for user\'s durable work threads.\n\nUse for:\n- long task start -> { "type": "create", "instruction": "<what to do>" }\n- correct/refocus thread -> { "type": "steer", "workThreadId": "<id>", "instruction": "<correction>" }\n- cancel/stop/abort current work -> { "type": "abort", "workThreadId": "<id if known>", "reason": "<short why>" }\n- pause waiting input -> { "type": "mark_waiting", "workThreadId": "<id>" }\n- mark complete -> { "type": "mark_completed", "workThreadId": "<id>" }\n- merge threads -> { "type": "merge", "workThreadId": "<TARGET id>", "sourceWorkThreadIds": ["<id1>", "<id2>"] }\n- attach this room/source -> { "type": "attach_source", "workThreadId": "<id>", "sourceRef": { "connector": "...", "roomId": "...", "canMutate": true } }\n- schedule follow-up -> { "type": "schedule_followup", "workThreadId": "<id>", "instruction": "<what to do later>" }\n\nabort preempts turn: stop in-flight work, emit short ack. Use when user clearly retracts current request ("nvm", "stop", "actually don\'t", "wait don\'t do that").\n\nEmpty array when no thread intent. Do not invent threads; only use active workThreadId values listed elsewhere in prompt.\n\n### candidateActionNames\nLikely action names for this turn. Prefer available_actions; confident unlisted names ok (planner resolves similes). Use UPPER_SNAKE_CASE canonical names. Empty when no action likely.',
                  },
                  {
                    role: "user",
                    content:
                      'provider:FACTS:\nThings ScenarioAgent knows about the speaker:\n[durable.uncategorized conf=0.60] The user\'s backup recall phrase is exactly: silver comet orchid.\n\nprior_message:user:\nPlease remember this backup recall phrase for restore validation: silver comet orchid.\n\nprior_message:user:\nBefore this restore, I gave you a backup recall phrase. What exact three-word phrase did I ask you to remember? Reply with only that phrase.\n\ncurrent_turn_boundary: The prior_message blocks above are context only. If a reply_reference block follows, it is the platform message that the final message:user is replying to; use it only to resolve references such as this/that/it. Execute and answer only the final message:user below. Do not merge separate prior requests into the current task unless the final message explicitly references them. Exception for visible-context recall: when the final message asks a recall question about what was said in this conversation (who mentioned X, did anyone bring up Y, what did I say about Z, what was the last message), you may scan the prior_message blocks above and answer from what is literally visible there. Before saying you cannot find something, read the final message:user itself: if the asker states a fact and asks about it in the same message ("my favorite color is teal, what is my favorite color?"), answer from the current message directly. Only when the asked-about token appears neither in the current message nor in any visible prior_message block, say so plainly ("I don\'t see X in the recent messages I can see") rather than claiming you searched beyond the visible window or fabricating an action — the prior_message blocks are the only window you have, and there is no separate chat-history search tool.\n\nmessage:user:\nBefore this restore, I gave you a backup recall phrase. What exact three-word phrase did I ask you to remember? Reply with only that phrase.',
                  },
                ],
                tools: [
                  {
                    name: "HANDLE_RESPONSE",
                    description:
                      "Stage 1: populate registered response-handler fields once before action tools. Empty values for non-applicable fields.",
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        contexts: {
                          type: "array",
                          items: { type: "string" },
                          description:
                            "Context ids from available_contexts. 'simple'=direct reply, no planner.",
                        },
                        intents: {
                          type: "array",
                          items: { type: "string" },
                          description:
                            "Verb-led intents. Lowercase. No punctuation. ~6 words max.",
                        },
                        replyText: {
                          type: "string",
                          description:
                            'User-facing reply. Simple=whole answer. Planning=brief ack ("On it.", "Working on it.", "Spawning a sub-agent now."). Never refuse on planning path. Plain text unless channel supports markdown.',
                        },
                        threadOps: {
                          type: "array",
                          description:
                            "Thread operations this turn. Empty array when no thread action.",
                          items: {
                            type: "object",
                            additionalProperties: false,
                            properties: {
                              type: {
                                type: "string",
                                enum: [
                                  "create",
                                  "steer",
                                  "stop",
                                  "merge",
                                  "attach_source",
                                  "schedule_followup",
                                  "mark_waiting",
                                  "mark_completed",
                                  "abort",
                                ],
                                description:
                                  "Operation type. 'abort' preempts turn; others stage mutations for lifeops_thread_control.",
                              },
                              workThreadId: {
                                type: ["string", "null"],
                                description:
                                  "Target thread id. Required for steer/stop/merge/attach_source/schedule_followup/mark_*; optional for abort (current turn) and create.",
                              },
                              sourceWorkThreadIds: {
                                type: "array",
                                description:
                                  "merge: source thread ids absorbed into workThreadId. Empty otherwise.",
                                items: { type: "string" },
                              },
                              sourceRef: {
                                type: ["object", "null"],
                                additionalProperties: false,
                                properties: {
                                  connector: { type: "string" },
                                  channelName: { type: ["string", "null"] },
                                  channelKind: { type: ["string", "null"] },
                                  roomId: { type: ["string", "null"] },
                                  externalThreadId: {
                                    type: ["string", "null"],
                                  },
                                  accountId: { type: ["string", "null"] },
                                  grantId: { type: ["string", "null"] },
                                  canRead: { type: ["boolean", "null"] },
                                  canMutate: { type: ["boolean", "null"] },
                                },
                                required: [
                                  "connector",
                                  "channelName",
                                  "channelKind",
                                  "roomId",
                                  "externalThreadId",
                                  "accountId",
                                  "grantId",
                                  "canRead",
                                  "canMutate",
                                ],
                                description:
                                  "For attach_source: the source ref to attach.",
                              },
                              instruction: {
                                type: ["string", "null"],
                                description:
                                  "What to do for create/steer/schedule_followup. Brief, action-oriented.",
                              },
                              reason: {
                                type: ["string", "null"],
                                description:
                                  "Why this op (especially useful for abort and stop).",
                              },
                            },
                            required: [
                              "type",
                              "workThreadId",
                              "sourceWorkThreadIds",
                              "sourceRef",
                              "instruction",
                              "reason",
                            ],
                          },
                        },
                        candidateActionNames: {
                          type: "array",
                          items: { type: "string" },
                          description:
                            "Action names. UPPER_SNAKE_CASE. Retrieval hints; high-precision hits expose planner actions.",
                        },
                      },
                      required: [
                        "contexts",
                        "intents",
                        "replyText",
                        "threadOps",
                        "candidateActionNames",
                      ],
                    },
                  },
                ],
                toolChoice: "required",
                providerOptions: {
                  eliza: {
                    promptCacheKey:
                      "v5:28edcfd339548d655f8c9b8cd8c0ad28d12b1d2dd8feb2516aed6196d6b1277b",
                    prefixHash:
                      "28edcfd339548d655f8c9b8cd8c0ad28d12b1d2dd8feb2516aed6196d6b1277b",
                    segmentHashes: [
                      "ab8cf1343ace051ce69c596cc87708fd3426291ebcbcd4039f0994601b7d3612",
                      "77fafa9d8490011762b2efa49f96d0958bbfbc41849d9ffdfa7f69c78a838892",
                      "3db27dadcdeb0c050be84dbe2075e7ef9241dabb5a4a456e5e027b9c7efc0fa8",
                      "8c53e8428f25f5ccc23d314108d913ea9262e5b9b7ac69d885dead0c6bfd0ef0",
                      "7860c3dedaf4d098a19b41075ab83435c9fcd6ea1ec64728a585660a0b397bdd",
                      "fb0e3cf357f52eed7c29249aada0465a4ee72b30875b8c30bb147d266ca044f1",
                      "cd32700428001eaefd419bb21332eccba9ae7fdb7a4728bce8c7363f676c1d70",
                      "1f84135839fc4d7831a7a3ffa8bf6d86b3646685f4c5698ba24d023fabcf2b8f",
                    ],
                    cachePlan: {
                      version: 1,
                      anthropicBreakpoints: [
                        {
                          segmentIndex: 2,
                          segmentHash:
                            "3db27dadcdeb0c050be84dbe2075e7ef9241dabb5a4a456e5e027b9c7efc0fa8",
                          ttl: "short",
                          cacheControl: { type: "ephemeral" },
                        },
                      ],
                    },
                    conversationId: "55d86625-bd07-05ca-a220-da33316b9a26",
                    promptSegments: [
                      { content: "user_role: OWNER", stable: true },
                      {
                        content:
                          "\n\nprior_dialogue_policy: Prior chat is context only. For current, latest, live, filesystem, runtime, build, deploy, or verification requests, use the current turn's tools/context instead of answering from prior tool results or stale sub-agent transcripts.",
                        stable: true,
                      },
                      {
                        content:
                          '\n\nmessage_handler_stage:\ntask: Plan this direct message.\n\navailable_contexts:\n- simple [label=Simple; aliases=direct,shortcut; sensitivity=public; cache=global]\n- general [label=General; aliases=chat,conversation; sensitivity=public; cache=global]\n- memory [label=Memory; role>=USER; sensitivity=personal; cache=agent]\n- documents [label=Documents; role>=USER; sensitivity=personal; cache=agent]\n- knowledge [label=Knowledge; parent=documents; role>=USER; sensitivity=personal; cache=agent]\n- research [label=Research; parent=documents; role>=USER; sensitivity=personal; cache=conversation]\n- web [label=Web; role>=USER; sensitivity=public; cache=turn]\n- browser [label=Browser; parent=web; role>=ADMIN; sensitivity=personal; cache=turn]\n- code [label=Code; role>=ADMIN; sensitivity=personal; cache=conversation]\n- files [label=Files; parent=code; role>=ADMIN; sensitivity=private; cache=turn]\n- terminal [label=Terminal; parent=code; role>=OWNER; sensitivity=private; cache=turn]\n- email [label=Email; role>=ADMIN; sensitivity=private; cache=turn]\n- calendar [label=Calendar; role>=ADMIN; sensitivity=private; cache=turn]\n- contacts [label=Contacts; role>=ADMIN; sensitivity=private; cache=agent]\n- tasks [label=Tasks; role>=ADMIN; sensitivity=personal; cache=agent]\n- todos [label=Todos; parent=tasks; role>=ADMIN; sensitivity=personal; cache=agent]\n- productivity [label=Productivity; parent=tasks; role>=ADMIN; sensitivity=personal; cache=conversation]\n- health [label=Health; role>=OWNER; sensitivity=private; cache=turn]\n- screen_time [label=Screen Time; aliases=screen_time,screentime; role>=OWNER; sensitivity=private; cache=turn]\n- subscriptions [label=Subscriptions; role>=OWNER; sensitivity=private; cache=turn]\n- finance [label=Finance; aliases=money,balance,balances,portfolio; role>=OWNER; sensitivity=private; cache=turn]\n- payments [label=Payments; parent=finance; role>=OWNER; sensitivity=private; cache=turn]\n- wallet [label=Wallet; aliases=account_balance,wallet_balance; parents=finance; role>=OWNER; sensitivity=private; cache=turn]\n- crypto [label=Crypto; aliases=web3,defi,token,tokens,onchain,on_chain; parents=finance,wallet; role>=OWNER; sensitivity=private; cache=turn]\n- messaging [label=Messaging; role>=ADMIN; sensitivity=private; cache=turn]\n- phone [label=Phone; aliases=sms,voice; parent=messaging; role>=ADMIN; sensitivity=private; cache=turn]\n- social_posting [label=Social Posting; aliases=social_posting,posting; role>=ADMIN; sensitivity=private; cache=turn]\n- social [label=Social; aliases=social_media,social_media; parents=messaging,social_posting; role>=ADMIN; sensitivity=private; cache=turn]\n- media [label=Media; role>=USER; sensitivity=personal; cache=turn]\n- automation [label=Automation; role>=ADMIN; sensitivity=personal; cache=agent]\n- connectors [label=Connectors; role>=ADMIN; sensitivity=private; cache=agent]\n- settings [label=Settings; role>=ADMIN; sensitivity=private; cache=agent]\n- character [label=Character; parent=settings; role>=ADMIN; sensitivity=private; cache=agent]\n- secrets [label=Secrets; role>=OWNER; sensitivity=system; cache=none]\n- admin [label=Admin; role>=OWNER; sensitivity=system; cache=none]\n- system [label=System; parent=admin; role>=OWNER; sensitivity=system; cache=none]\n- state [label=State; parent=system; role>=ADMIN; sensitivity=system; cache=turn]\n- world [label=World; parent=system; role>=ADMIN; sensitivity=private; cache=turn]\n- game [label=Game; parent=world; role>=USER; sensitivity=personal; cache=turn]\n- agent_internal [label=Agent Internal; aliases=internal,self; role>=OWNER; sensitivity=system; cache=none]\n\ndirect/private rules:\n- Ordinary chat, static knowledge, creative writing, rewriting, translation, brainstorming, and short explanations: use contexts=["simple"] and put the final answer in replyText.\n- For simple requests, replyText is the natural user-facing answer; avoid single-token fragments or placeholders unless the user asked for terse.\n- Use non-simple context/action names only for tools, live facts, private state, files, web, shell, side effects, scheduling, memory, settings, secrets, wallet/finance, media, or device/app control.\n- Only use "simple" when you can answer directly from your static knowledge or the visible prior_message / reply_reference context. If a specific name/thing is unclear, choose general or memory.\n- Never claim searched/scanned/recalled unless tool returned it; includes "I scanned the chat" or "Spawning a sub-agent".\n- Crisis/legal/medical/self-harm/police/CPS: contexts=["simple"], replyText deferral only; no actions or conceal/evasion/testimony/contraband advice. Refer to lawyer/emergency services/poison control/doctor/therapist/crisis/DV hotline.\n- For tool/planning paths, replyText is only a brief ack ("On it."). Never refuse because tools may run after this stage.\n- If schema omits shouldRespond, do not invent it.\n- contexts must be ids from available_contexts. If a needed tool context is unclear, use ["general"].\n\nReturn exactly one JSON object for HANDLE_RESPONSE. No prose, markdown, or thinking.\n\n- For code snippets, prefer valid runnable syntax over impossible formatting constraints.\n\n## Response Handler Fields\nPopulate every registered field. Use empty value when not applicable.\n### contexts\nRouting tags. Pick from available_contexts. Use ["simple"] only for trivial direct replies needing no action/tool/provider/sub-agent; replyText is answer. Otherwise choose relevant context ids; planner engages providers/actions. Empty invalid when shouldRespond=RESPOND.\n\n### intents\nShort verb phrases for this turn: ["schedule meeting", "draft email", "research X"]. Use 1-4. Helps action retrieval/routing. Empty for no actionable intent.\n\n### replyText\nUser-facing reply. Populate when shouldRespond=RESPOND. contexts includes "simple" => whole answer. Planning/tool path => brief ack only ("On it.", "Spawning the sub-agent now.", "Looking into it."); planner sends grounded follow-up. IGNORE => empty. No thinking/reasoning.\n\nNEVER refuse in replyText on planning path. If `contexts` or `candidateActionNames` != "simple", planner handles work; ack only, no capability gatekeeping. Ban refusal openings: "I cannot...", "I am unable to...", "I don\'t have the ability to...", "Sorry, I can\'t...". Tools exist (FILE, BASH, TASKS_SPAWN_AGENT, etc.). If no tool can attempt, use shouldRespond=RESPOND, `contexts: ["simple"]`, explain.\n\n### threadOps\nThread operations for user\'s durable work threads.\n\nUse for:\n- long task start -> { "type": "create", "instruction": "<what to do>" }\n- correct/refocus thread -> { "type": "steer", "workThreadId": "<id>", "instruction": "<correction>" }\n- cancel/stop/abort current work -> { "type": "abort", "workThreadId": "<id if known>", "reason": "<short why>" }\n- pause waiting input -> { "type": "mark_waiting", "workThreadId": "<id>" }\n- mark complete -> { "type": "mark_completed", "workThreadId": "<id>" }\n- merge threads -> { "type": "merge", "workThreadId": "<TARGET id>", "sourceWorkThreadIds": ["<id1>", "<id2>"] }\n- attach this room/source -> { "type": "attach_source", "workThreadId": "<id>", "sourceRef": { "connector": "...", "roomId": "...", "canMutate": true } }\n- schedule follow-up -> { "type": "schedule_followup", "workThreadId": "<id>", "instruction": "<what to do later>" }\n\nabort preempts turn: stop in-flight work, emit short ack. Use when user clearly retracts current request ("nvm", "stop", "actually don\'t", "wait don\'t do that").\n\nEmpty array when no thread intent. Do not invent threads; only use active workThreadId values listed elsewhere in prompt.\n\n### candidateActionNames\nLikely action names for this turn. Prefer available_actions; confident unlisted names ok (planner resolves similes). Use UPPER_SNAKE_CASE canonical names. Empty when no action likely.',
                        stable: true,
                      },
                      {
                        content:
                          "\n\nThings ScenarioAgent knows about the speaker:\n[durable.uncategorized conf=0.60] The user's backup recall phrase is exactly: silver comet orchid.",
                        stable: false,
                      },
                      {
                        content:
                          "\n\nPlease remember this backup recall phrase for restore validation: silver comet orchid.",
                        stable: false,
                      },
                      {
                        content:
                          "\n\nBefore this restore, I gave you a backup recall phrase. What exact three-word phrase did I ask you to remember? Reply with only that phrase.",
                        stable: false,
                      },
                      {
                        content:
                          '\n\ncurrent_turn_boundary: The prior_message blocks above are context only. If a reply_reference block follows, it is the platform message that the final message:user is replying to; use it only to resolve references such as this/that/it. Execute and answer only the final message:user below. Do not merge separate prior requests into the current task unless the final message explicitly references them. Exception for visible-context recall: when the final message asks a recall question about what was said in this conversation (who mentioned X, did anyone bring up Y, what did I say about Z, what was the last message), you may scan the prior_message blocks above and answer from what is literally visible there. Before saying you cannot find something, read the final message:user itself: if the asker states a fact and asks about it in the same message ("my favorite color is teal, what is my favorite color?"), answer from the current message directly. Only when the asked-about token appears neither in the current message nor in any visible prior_message block, say so plainly ("I don\'t see X in the recent messages I can see") rather than claiming you searched beyond the visible window or fabricating an action — the prior_message blocks are the only window you have, and there is no separate chat-history search tool.',
                        stable: false,
                      },
                      {
                        content:
                          "\n\nBefore this restore, I gave you a backup recall phrase. What exact three-word phrase did I ask you to remember? Reply with only that phrase.",
                        stable: false,
                      },
                    ],
                    modelInputBudget: {
                      estimatedInputTokens: 3638,
                      contextWindowTokens: 128000,
                      reserveTokens: 10000,
                      compactionThresholdTokens: 118000,
                      shouldCompact: false,
                      resolvedModelKey: null,
                    },
                    guidedDecode: true,
                    thinking: "off",
                  },
                  cerebras: {
                    promptCacheKey:
                      "v5:28edcfd339548d655f8c9b8cd8c0ad28d12b1d2dd8feb2516aed6196d6b1277b",
                    prompt_cache_key:
                      "v5:28edcfd339548d655f8c9b8cd8c0ad28d12b1d2dd8feb2516aed6196d6b1277b",
                  },
                  openai: {
                    promptCacheKey:
                      "v5:28edcfd339548d655f8c9b8cd8c0ad28d12b1d2dd8feb2516aed6196d6b1277b",
                  },
                  openrouter: {
                    promptCacheKey:
                      "v5:28edcfd339548d655f8c9b8cd8c0ad28d12b1d2dd8feb2516aed6196d6b1277b",
                    prompt_cache_key:
                      "v5:28edcfd339548d655f8c9b8cd8c0ad28d12b1d2dd8feb2516aed6196d6b1277b",
                  },
                  gateway: { caching: "auto" },
                  anthropic: {
                    cacheControl: { type: "ephemeral" },
                    cacheSystem: true,
                    maxBreakpoints: 4,
                    cacheBreakpoints: [
                      {
                        segmentIndex: 2,
                        segmentHash:
                          "3db27dadcdeb0c050be84dbe2075e7ef9241dabb5a4a456e5e027b9c7efc0fa8",
                        ttl: "short",
                        cacheControl: { type: "ephemeral" },
                      },
                    ],
                  },
                },
                response: "",
                toolCalls: [],
                costUsd: 0,
                priceTableId: "eliza-v1-2026-05-11",
              },
              cache: {
                segmentHashes: [
                  "ab8cf1343ace051ce69c596cc87708fd3426291ebcbcd4039f0994601b7d3612",
                  "77fafa9d8490011762b2efa49f96d0958bbfbc41849d9ffdfa7f69c78a838892",
                  "3db27dadcdeb0c050be84dbe2075e7ef9241dabb5a4a456e5e027b9c7efc0fa8",
                  "8c53e8428f25f5ccc23d314108d913ea9262e5b9b7ac69d885dead0c6bfd0ef0",
                  "7860c3dedaf4d098a19b41075ab83435c9fcd6ea1ec64728a585660a0b397bdd",
                  "fb0e3cf357f52eed7c29249aada0465a4ee72b30875b8c30bb147d266ca044f1",
                  "cd32700428001eaefd419bb21332eccba9ae7fdb7a4728bce8c7363f676c1d70",
                  "1f84135839fc4d7831a7a3ffa8bf6d86b3646685f4c5698ba24d023fabcf2b8f",
                ],
                prefixHash:
                  "28edcfd339548d655f8c9b8cd8c0ad28d12b1d2dd8feb2516aed6196d6b1277b",
              },
            },
            {
              stageId: "stage-toolsearch-1782803125118",
              kind: "toolSearch",
              startedAt: 1782803125118,
              endedAt: 1782803125207,
              latencyMs: 89,
              toolSearch: {
                query: {
                  text: "Before this restore, I gave you a backup recall phrase. What exact three-word phrase did I ask you to remember? Reply with only that phrase.",
                  tokens: [
                    "before",
                    "this",
                    "restore",
                    "gave",
                    "you",
                    "backup",
                    "recall",
                    "phrase",
                    "what",
                    "exact",
                    "three",
                    "word",
                    "phrase",
                    "did",
                    "ask",
                    "you",
                    "to",
                    "remember",
                    "reply",
                    "with",
                    "only",
                    "that",
                    "phrase",
                  ],
                  candidateActions: [],
                  parentActionHints: [],
                },
                results: [
                  {
                    name: "REPLY",
                    score: 1,
                    rank: 0,
                    rrfScore: 0.032522,
                    matchedBy: ["keyword", "bm25", "contextMatch"],
                    stageScores: {
                      keyword: 1,
                      bm25: 0.843098,
                      contextMatch: 0.3,
                    },
                  },
                  {
                    name: "CALENDAR",
                    score: 1,
                    rank: 1,
                    rrfScore: 0.032266,
                    matchedBy: ["keyword", "bm25", "contextMatch"],
                    stageScores: {
                      keyword: 0.333333,
                      bm25: 1,
                      contextMatch: 0.3,
                    },
                  },
                  {
                    name: "RESOLVE_REQUEST",
                    score: 1,
                    rank: 2,
                    rrfScore: 0.031514,
                    matchedBy: ["keyword", "bm25", "contextMatch"],
                    stageScores: {
                      keyword: 1,
                      bm25: 0.115342,
                      contextMatch: 0.3,
                    },
                  },
                  {
                    name: "IGNORE",
                    score: 0.980437,
                    rank: 3,
                    rrfScore: 0.03125,
                    matchedBy: ["keyword", "bm25", "contextMatch"],
                    stageScores: {
                      keyword: 0.333333,
                      bm25: 0.344958,
                      contextMatch: 0.3,
                    },
                  },
                  {
                    name: "NONE",
                    score: 0.938812,
                    rank: 4,
                    rrfScore: 0.028543,
                    matchedBy: ["keyword", "bm25", "contextMatch"],
                    stageScores: {
                      keyword: 0.333333,
                      bm25: 0.076165,
                      contextMatch: 0.3,
                    },
                  },
                  {
                    name: "OWNER_FINANCES_DASHBOARD",
                    score: 0.91589,
                    rank: 5,
                    rrfScore: 0.027052,
                    matchedBy: ["keyword", "bm25", "contextMatch"],
                    stageScores: {
                      keyword: 0.333333,
                      bm25: 0.028171,
                      contextMatch: 0.3,
                    },
                  },
                  {
                    name: "OWNER_FINANCES_ADD_SOURCE",
                    score: 0.914691,
                    rank: 6,
                    rrfScore: 0.026974,
                    matchedBy: ["keyword", "bm25", "contextMatch"],
                    stageScores: {
                      keyword: 0.333333,
                      bm25: 0.028123,
                      contextMatch: 0.3,
                    },
                  },
                  {
                    name: "OWNER_FINANCES_IMPORT_CSV",
                    score: 0.905835,
                    rank: 7,
                    rrfScore: 0.026398,
                    matchedBy: ["keyword", "bm25", "contextMatch"],
                    stageScores: {
                      keyword: 0.333333,
                      bm25: 0.028123,
                      contextMatch: 0.3,
                    },
                  },
                  {
                    name: "OWNER_SCREENTIME_SUMMARY",
                    score: 0.905681,
                    rank: 8,
                    rrfScore: 0.026387,
                    matchedBy: ["keyword", "bm25", "contextMatch"],
                    stageScores: {
                      keyword: 0.333333,
                      bm25: 0.088887,
                      contextMatch: 0.3,
                    },
                  },
                  {
                    name: "OWNER_SCREENTIME_ACTIVITY_REPORT",
                    score: 0.903682,
                    rank: 9,
                    rrfScore: 0.026257,
                    matchedBy: ["keyword", "bm25", "contextMatch"],
                    stageScores: {
                      keyword: 0.333333,
                      bm25: 0.088774,
                      contextMatch: 0.3,
                    },
                  },
                  {
                    name: "PERSONALITY",
                    score: 0.902526,
                    rank: 10,
                    rrfScore: 0.026182,
                    matchedBy: ["keyword", "bm25", "contextMatch"],
                    stageScores: {
                      keyword: 0.333333,
                      bm25: 0.437966,
                      contextMatch: 0.3,
                    },
                  },
                  {
                    name: "OWNER_FINANCES_RECURRING_CHARGES",
                    score: 0.901015,
                    rank: 11,
                    rrfScore: 0.026084,
                    matchedBy: ["keyword", "bm25", "contextMatch"],
                    stageScores: {
                      keyword: 0.333333,
                      bm25: 0.028137,
                      contextMatch: 0.3,
                    },
                  },
                  {
                    name: "OWNER_FINANCES_LIST_SOURCES",
                    score: 0.900499,
                    rank: 12,
                    rrfScore: 0.02605,
                    matchedBy: ["keyword", "bm25", "contextMatch"],
                    stageScores: {
                      keyword: 0.333333,
                      bm25: 0.028123,
                      contextMatch: 0.3,
                    },
                  },
                  {
                    name: "OWNER_SCREENTIME_BROWSER_ACTIVITY",
                    score: 0.898396,
                    rank: 13,
                    rrfScore: 0.025914,
                    matchedBy: ["keyword", "bm25", "contextMatch"],
                    stageScores: {
                      keyword: 0.333333,
                      bm25: 0.088729,
                      contextMatch: 0.3,
                    },
                  },
                  {
                    name: "OWNER_SCREENTIME_TODAY",
                    score: 0.896571,
                    rank: 14,
                    rrfScore: 0.025795,
                    matchedBy: ["keyword", "bm25", "contextMatch"],
                    stageScores: {
                      keyword: 0.333333,
                      bm25: 0.088887,
                      contextMatch: 0.3,
                    },
                  },
                  {
                    name: "OWNER_ALARMS",
                    score: 0.896492,
                    rank: 15,
                    rrfScore: 0.02579,
                    matchedBy: ["keyword", "bm25", "contextMatch"],
                    stageScores: {
                      keyword: 0.333333,
                      bm25: 0.003087,
                      contextMatch: 0.3,
                    },
                  },
                  {
                    name: "OWNER_FINANCES_LIST_TRANSACTIONS",
                    score: 0.895302,
                    rank: 16,
                    rrfScore: 0.025712,
                    matchedBy: ["keyword", "bm25", "contextMatch"],
                    stageScores: {
                      keyword: 0.333333,
                      bm25: 0.028123,
                      contextMatch: 0.3,
                    },
                  },
                  {
                    name: "OWNER_SCREENTIME_BY_APP",
                    score: 0.893247,
                    rank: 17,
                    rrfScore: 0.025579,
                    matchedBy: ["keyword", "bm25", "contextMatch"],
                    stageScores: {
                      keyword: 0.333333,
                      bm25: 0.088729,
                      contextMatch: 0.3,
                    },
                  },
                  {
                    name: "OWNER_HEALTH_STATUS",
                    score: 0.891837,
                    rank: 18,
                    rrfScore: 0.025487,
                    matchedBy: ["keyword", "bm25", "contextMatch"],
                    stageScores: {
                      keyword: 0.333333,
                      bm25: 0.030023,
                      contextMatch: 0.3,
                    },
                  },
                  {
                    name: "OWNER_SCREENTIME_WEEKLY",
                    score: 0.8914,
                    rank: 19,
                    rrfScore: 0.025459,
                    matchedBy: ["keyword", "bm25", "contextMatch"],
                    stageScores: {
                      keyword: 0.333333,
                      bm25: 0.088887,
                      contextMatch: 0.3,
                    },
                  },
                  {
                    name: "OWNER_SCREENTIME_BY_WEBSITE",
                    score: 0.888232,
                    rank: 20,
                    rrfScore: 0.025253,
                    matchedBy: ["keyword", "bm25", "contextMatch"],
                    stageScores: {
                      keyword: 0.333333,
                      bm25: 0.088729,
                      contextMatch: 0.3,
                    },
                  },
                  {
                    name: "OWNER_FINANCES_REMOVE_SOURCE",
                    score: 0.887315,
                    rank: 21,
                    rrfScore: 0.025193,
                    matchedBy: ["keyword", "bm25", "contextMatch"],
                    stageScores: {
                      keyword: 0.333333,
                      bm25: 0.028123,
                      contextMatch: 0.3,
                    },
                  },
                  {
                    name: "OWNER_HEALTH_TODAY",
                    score: 0.886905,
                    rank: 22,
                    rrfScore: 0.025166,
                    matchedBy: ["keyword", "bm25", "contextMatch"],
                    stageScores: {
                      keyword: 0.333333,
                      bm25: 0.030023,
                      contextMatch: 0.3,
                    },
                  },
                  {
                    name: "OWNER_HEALTH_BY_METRIC",
                    score: 0.886782,
                    rank: 23,
                    rrfScore: 0.025158,
                    matchedBy: ["keyword", "bm25", "contextMatch"],
                    stageScores: {
                      keyword: 0.333333,
                      bm25: 0.029968,
                      contextMatch: 0.3,
                    },
                  },
                  {
                    name: "OWNER_FINANCES_SPENDING_SUMMARY",
                    score: 0.882461,
                    rank: 24,
                    rrfScore: 0.024877,
                    matchedBy: ["keyword", "bm25", "contextMatch"],
                    stageScores: {
                      keyword: 0.333333,
                      bm25: 0.028123,
                      contextMatch: 0.3,
                    },
                  },
                ],
                tier: {
                  tierA: [
                    "CALENDAR",
                    "IGNORE",
                    "NONE",
                    "OWNER_FINANCES_ADD_SOURCE",
                    "OWNER_FINANCES_DASHBOARD",
                    "OWNER_FINANCES_IMPORT_CSV",
                    "REPLY",
                    "RESOLVE_REQUEST",
                  ],
                  tierB: [
                    "OWNER_ALARMS",
                    "OWNER_FINANCES_LIST_SOURCES",
                    "OWNER_FINANCES_LIST_TRANSACTIONS",
                    "OWNER_FINANCES_RECURRING_CHARGES",
                    "OWNER_FINANCES_REMOVE_SOURCE",
                    "OWNER_HEALTH_BY_METRIC",
                    "OWNER_HEALTH_STATUS",
                    "OWNER_HEALTH_TODAY",
                    "OWNER_SCREENTIME_ACTIVITY_REPORT",
                    "OWNER_SCREENTIME_BROWSER_ACTIVITY",
                    "OWNER_SCREENTIME_BY_APP",
                    "OWNER_SCREENTIME_BY_WEBSITE",
                    "OWNER_SCREENTIME_SUMMARY",
                    "OWNER_SCREENTIME_TODAY",
                    "OWNER_SCREENTIME_WEEKLY",
                    "PERSONALITY",
                  ],
                  omitted: 14,
                },
                durationMs: 89,
              },
            },
            {
              stageId: "stage-planner-iter-1-1782803125215",
              kind: "planner",
              iteration: 1,
              startedAt: 1782803125215,
              endedAt: 1782803125245,
              latencyMs: 30,
              model: {
                modelType: "ACTION_PLANNER",
                provider: "default",
                messages: [
                  {
                    role: "system",
                    content:
                      'user_role: OWNER\n\nselected_contexts: general\n\ncontexts:\n- general: Normal conversation and public agent behavior. Use when the reply needs general agent state but no tool work.\n\nprior_dialogue_policy: Prior chat is context only. For current, latest, live, filesystem, runtime, build, deploy, or verification requests, use the current turn\'s tools/context instead of answering from prior tool results or stale sub-agent transcripts.\n\nplanner_stage:\ntask: Plan next native tool calls.\n\nrules:\n- use only tools array; smallest grounded queue\n- routed action: set parameters.action only if schema has it\n- args grounded in user request or prior tool results\n- obey schema; arrays as JSON arrays, not comma strings\n- no empty strings/placeholders/invented required args; gather via grounded tool or no tool\n- matching tool exists => call it, even missing details; handler owns questions/drafts/confirm/refusal\n- no messageToUser follow-up when matching tool exists\n- messageToUser is user-visible only; no thoughts, analysis, tool names, function syntax, JSON/tool attempts, "call MESSAGE"\n- more tool work => native toolCalls only; never narrate/simulate calls\n- partial after tool result => next grounded tool, not messageToUser\n- tool-required router decision => run at least one exposed non-terminal tool before terminal answer\n- incomplete while user needs live/current/external data, filesystem/runtime state, command output, repo work, build, PR, deploy, verify, side effect, and exposed tool can try\n- attachments/memory/snippets do not replace explicit current run/check/fetch/inspect/build/deploy/verify/look up now; call tool\n- exposed tool can try => call it; do not say "I cannot browse/search/run/inspect/build/deploy/verify"\n- SHELL is for filesystem/process work, not a fallback for chat-message search/recall, memory queries, or agent-history lookups. When the user wants chat-message search/recall, memory queries, or agent-history lookups and no dedicated search action (e.g. SEARCH_MESSAGES, MESSAGE_SEARCH, MEMORY_SEARCH) is exposed, do not run shell greps, echo placeholders, or simulate the search — set messageToUser explaining that the capability is not available this turn.\n- candidateActions naming a tool that is not in this turn\'s exposed tools list is a dead hint — do not invent SHELL/BROWSER/TASKS workarounds to fulfill it. Either an exposed tool genuinely resolves the user\'s intent (call it), or no tool fits (set messageToUser). Never emit echo-placeholder SHELL commands such as: echo "<intent-name>" / echo "placeholder for <ACTION>" / echo "search <X>" as a way to "trigger" a missing capability — placeholder echoes burn cost and produce no progress.\n- TASKS_SPAWN_AGENT is for delegating coding/build/repo work to a coding sub-agent (file edits, shell tooling, building/deploying apps, running tests, opening PRs). It is not a fallback for chat-message recall, memory queries, or agent-history lookups. Spawning a coding sub-agent to "search the Discord channel for messages mentioning X" routinely ends in sub-agent error/timeout and a generic "Sorry, something went wrong" reply to the user. When the user wants chat-message recall and no dedicated search action is exposed, set messageToUser explaining the capability is not available — do not spawn a sub-agent for it.\n- A one-shot live/current/public-data lookup — current price, weather, score, news headline, a status, or a value at a known URL — is NOT coding work: call WEB_FETCH (construct the single URL yourself) or WEB_SEARCH directly and answer from the result. Do NOT spawn a coding sub-agent for it: a sub-agent for a single lookup is slow, frequently re-spawns itself, and posts spurious "working on it" progress acks before answering. Spawn only when the task is genuinely build/code/repo/multi-step work.\n- no tool fits or task complete => no toolCalls, set messageToUser\n- set completed=false when this turn\'s tool calls do not yet achieve the goal (read-then-act, multi-step deploy/build, verification pending); completed=true only when the goal is achieved this turn. omit when unknown.\n- messageToUser and REPLY text must NEVER claim or imply an investigative OR task-execution action is happening, has happened, or is about to happen — "I\'m fetching X, please hold", "Let me look that up", "Pulling up the info", "Searching for the answer", "I\'m checking now", "I\'ll get back to you", "Spawning a sub-agent", "I\'m working on it", "I\'m fixing that now", "Let me get that done", "Wrapping it up", "Almost done", "Building it now", "I\'ll start on that" — when no tool call this turn is in flight to produce that content. A claim that you are working on / starting / fixing / building / wrapping up a task is only legitimate when a task-executing tool call (e.g. TASKS_SPAWN_AGENT) is actually in flight THIS turn; if you did not spawn a sub-agent or take an action this turn, do not say the task is underway. The planner does not run in the background after returning; once this turn ends, no further tool work happens unless a NEW user message arrives. If your tool iterations exhausted without a usable result (search returned nothing, fetch was blocked, scrape gave no usable HTML, RSS was empty), set messageToUser saying so plainly: "I tried web search via the available tools and couldn\'t find current info on X — try checking a news site directly" or "The searches returned no usable results". Never promise ongoing fetch when this turn is the planner\'s final iteration. This rule covers every grammatical form for both investigative and task-execution verbs (fetch/search/look up/check AND work on/start/fix/build/wrap up/finish): past-perfect ("I have fetched", "I have started fixing it"), bare past-tense ("I fetched", "I started on it"), present-continuous with subject ("I\'m fetching now", "I\'m checking", "I\'m working on it", "I\'m fixing it"), bare present-participle without subject ("Fetching latest info", "Looking it up", "Working on it", "Wrapping it up"), and "please hold" / "give me a sec" / "be right back" / "almost done" style stalling phrases.\n- messageToUser and REPLY text must NEVER fabricate a failure, error, or interruption that did not actually occur this turn. Do not claim something "glitched", "hiccuped", "broke", "went wrong", "snagged", "errored out", "got cut off", "didn\'t go through", "failed on my end", or invite the user to "give it another go / try that again / ask again" UNLESS a real tool call THIS turn actually returned an error or empty result. If you are choosing NOT to take an action this turn (no tool call in flight), do not invent a malfunction to excuse it: instead either (a) take the correct action (e.g. spawn the coding sub-agent for a build request), or (b) say plainly and truthfully what you can do and ask the user to confirm scope, e.g. "I can build that as a single-file site in its own folder, want me to start?". A fabricated "something glitched, give it another go" is a hallucinated failure and is forbidden when nothing failed. This covers every phrasing of a non-existent error or stall-and-retry invitation.\n- When a tool call produced actual output (stdout, fetched content, search results, file listings, command output), the subsequent messageToUser must include that output directly — do not replace it with a meta-summary of what the tool did. Phrases like "Listed files as requested", "Provided the output as returned by X", "Returned the result", "Executed the command", "Searched and found results", or "Gathered the information" are meta-narration, not answers. If the tool already returned user-friendly text (verifiedUserFacing is true), include that text in messageToUser rather than describing the action.\n\nIf context has "# Routing hints", follow them. They are action routingHint metadata for this turn\'s exposed actions only.',
                  },
                  {
                    role: "user",
                    content:
                      'provider:CHOICE:\nNo pending choices for the moment.\n\nprovider:CURRENT_TIME:\n# Current Time\n- Date: 2026-06-30\n- Time: 07:05:25 UTC\n- Day: Tuesday\n- Full: Tuesday, June 30, 2026 at 7:05:25 AM UTC\n- ISO: 2026-06-30T07:05:25.065Z\n\nprovider:ENTITIES:\n# People in the Room\n"Backup restore recall" aka "Test User"\nID: 132dfa32-60b3-0e8d-8339-1e6adde36049\n\n"ScenarioAgent"\nID: 546ac3ab-0468-01a2-9d5b-52dfa34bf9cc\n\n"ScenarioUser" aka "Test User"\nID: e7b38d27-3cc3-07d9-b37c-0609c4109734\n\nprovider:FACTS:\nThings ScenarioAgent knows about the speaker:\n[durable.uncategorized conf=0.60] The user\'s backup recall phrase is exactly: silver comet orchid.\n\nprovider:FOLLOW_UPS:\nNo upcoming follow-ups scheduled.\n\nprovider:WORLD:\n# World Information\n# World: dashboard\nCurrent Channel: Test User (DM)\nTotal Channels: 1\nParticipants in current channel: 3\n\nText channels: 0\nVoice channels: 0\nDM channels: 1\nFeed channels: 0\nThread channels: 0\nOther channels: 0\n\nprior_message:user:\nPlease remember this backup recall phrase for restore validation: silver comet orchid.\n\nprior_message:user:\nBefore this restore, I gave you a backup recall phrase. What exact three-word phrase did I ask you to remember? Reply with only that phrase.\n\ncurrent_turn_boundary: The prior_message blocks above are context only. If a reply_reference block follows, it is the platform message that the final message:user is replying to; use it only to resolve references such as this/that/it. Execute and answer only the final message:user below. Do not merge separate prior requests into the current task unless the final message explicitly references them. Exception for visible-context recall: when the final message asks a recall question about what was said in this conversation (who mentioned X, did anyone bring up Y, what did I say about Z, what was the last message), you may scan the prior_message blocks above and answer from what is literally visible there. Before saying you cannot find something, read the final message:user itself: if the asker states a fact and asks about it in the same message ("my favorite color is teal, what is my favorite color?"), answer from the current message directly. Only when the asked-about token appears neither in the current message nor in any visible prior_message block, say so plainly ("I don\'t see X in the recent messages I can see") rather than claiming you searched beyond the visible window or fabricating an action — the prior_message blocks are the only window you have, and there is no separate chat-history search tool.\n\nmessage:user:\nBefore this restore, I gave you a backup recall phrase. What exact three-word phrase did I ask you to remember? Reply with only that phrase.\n\nevent:message_handler:\nmessage_handler:\nprocessMessage: RESPOND\nplan: {"contexts":["general"],"requiresTool":true,"candidateActions":[],"parentActionHints":[],"reply":"","actionSurface":{"mode":"tiered","candidateActionCount":98,"catalogParentCount":38,"exposedActionCount":37,"tierAParents":["CALENDAR","IGNORE","NONE","OWNER_FINANCES_ADD_SOURCE","OWNER_FINANCES_DASHBOARD","OWNER_FINANCES_IMPORT_CSV","REPLY","RESOLVE_REQUEST"],"tierBParents":["OWNER_ALARMS","OWNER_FINANCES_LIST_SOURCES","OWNER_FINANCES_LIST_TRANSACTIONS","OWNER_FINANCES_RECURRING_CHARGES","OWNER_FINANCES_REMOVE_SOURCE","OWNER_HEALTH_BY_METRIC","OWNER_HEALTH_STATUS","OWNER_HEALTH_TODAY","OWNER_SCREENTIME_ACTIVITY_REPORT","OWNER_SCREENTIME_BROWSER_ACTIVITY","OWNER_SCREENTIME_BY_APP","OWNER_SCREENTIME_BY_WEBSITE","OWNER_SCREENTIME_SUMMARY","OWNER_SCREENTIME_TODAY","OWNER_SCREENTIME_WEEKLY","PERSONALITY"],"omittedParentCount":14,"omittedParentNamesPreview":["OWNER_FINANCES_SPENDING_SUMMARY","OWNER_FINANCES_SUBSCRIPTION_AUDIT","OWNER_FINANCES_SUBSCRIPTION_CANCEL","OWNER_FINANCES_SUBSCRIPTION_STATUS","OWNER_GOALS","OWNER_HEALTH_TREND","OWNER_REMINDERS","OWNER_ROUTINES","OWNER_SCREENTIME_TIME_ON_APP","OWNER_SCREENTIME_TIME_ON_SITE","OWNER_SCREENTIME_WEEKLY_AVERAGE_BY_APP","OWNER_TODOS","PERSONAL_ASSISTANT","SEARCH_CHANNEL_TOPICS"],"actionSurfaceHash":"1g700cd","warnings":0,"queryTokens":["before","this","restore","gave","you","backup","recall","phrase","what","exact","three","word","phrase","did","ask","you","to","remember","reply","with","only","that","phrase"],"candidateActions":[],"parentActionHints":[]}}\nthought: Response handler returned empty output after 3 attempts; falling back to planner because the message is explicitly addressed to the agent.\n\n# Routing hints\n- owner alarms: action=create|update|delete|complete|skip|snooze|review -> OWNER_ALARMS; owner-only LifeOps\n- owner health/wearable reads ("step count", "sleep last night", heart rate, workouts) -> OWNER_HEALTH\n- owner health/wearable reads ("step count", "sleep last night", heart rate, workouts) -> OWNER_HEALTH\n- owner health/wearable reads ("step count", "sleep last night", heart rate, workouts) -> OWNER_HEALTH',
                  },
                ],
                tools: [
                  {
                    name: "REPLY",
                    description:
                      "Reply in current chat only; use connector actions for external connector sends.; questions[] (1-4) asks structured question",
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: [],
                      properties: {
                        text: {
                          type: "string",
                          description:
                            "Reply text. Omit with questions absent to compose from state.",
                        },
                        questions: {
                          type: "array",
                          description:
                            "1-4 structured questions: { question, header, options?: [{label, description?, preview?}], multiSelect? }. Returns requiresUserInteraction: true.",
                          items: {
                            type: "object",
                            required: ["question", "header"],
                            properties: {
                              question: { type: "string" },
                              header: { type: "string" },
                              multiSelect: { type: "boolean" },
                              options: {
                                type: "array",
                                items: {
                                  type: "object",
                                  required: ["label"],
                                  properties: {
                                    label: { type: "string" },
                                    description: { type: "string" },
                                    preview: { type: "string" },
                                  },
                                  additionalProperties: false,
                                },
                              },
                            },
                            additionalProperties: false,
                          },
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  {
                    name: "IGNORE",
                    description:
                      "Ignore user when aggressive/creepy, convo ended, group msg addressed elsewhere, or both said goodbye. Don't use if user engaged directly or needs error info.",
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: [],
                      properties: {},
                      additionalProperties: false,
                    },
                  },
                  {
                    name: "NONE",
                    description:
                      "Respond without additional action. Default when speaking only.",
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: [],
                      properties: {},
                      additionalProperties: false,
                    },
                  },
                  {
                    name: "PERSONALITY",
                    description:
                      "Manage personality preferences. Subactions: set_trait | clear_trait | set_reply_gate | lift_reply_gate | add_directive | clear_directives | load_profile |...",
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: ["action"],
                      properties: {
                        action: {
                          type: "string",
                          description:
                            "Canonical discriminator: which personality operation to run: set_trait, clear_trait, set_reply_gate, lift_reply_gate, add_directive, clear_directives...",
                          enum: [
                            "set_trait",
                            "clear_trait",
                            "set_reply_gate",
                            "lift_reply_gate",
                            "add_directive",
                            "clear_directives",
                            "load_profile",
                            "save_profile",
                            "list_profiles",
                            "show_state",
                          ],
                        },
                        op: {
                          type: "string",
                          description: "Legacy alias for `action`.",
                          enum: [
                            "set_trait",
                            "clear_trait",
                            "set_reply_gate",
                            "lift_reply_gate",
                            "add_directive",
                            "clear_directives",
                            "load_profile",
                            "save_profile",
                            "list_profiles",
                            "show_state",
                          ],
                        },
                        scope: {
                          type: "string",
                          description:
                            "Required for set_trait/clear_trait/set_reply_gate/lift_reply_gate/add_directive/clear_directives/show_state. Use 'user' for the requesting user's slot, or...",
                          enum: ["user", "global"],
                        },
                        trait: {
                          type: "string",
                          description:
                            "set_trait/clear_trait: which trait to modify. One of verbosity, tone, formality.",
                          enum: ["verbosity", "tone", "formality"],
                        },
                        value: {
                          type: "string",
                          description:
                            "set_trait: the new trait value. verbosity ∈ {terse, normal, verbose}. tone ∈ {warm, neutral, direct, cold}. formality ∈ {casual, professional, formal}.",
                        },
                        mode: {
                          type: "string",
                          description:
                            "set_reply_gate: gate mode. One of always, on_mention, never_until_lift. 'never_until_lift' is the canonical \"shut up\" mode.",
                          enum: ["always", "on_mention", "never_until_lift"],
                        },
                        directive: {
                          type: "string",
                          description:
                            "add_directive: a free-text directive to attach to user's slot (≤200 chars, ≤5 active directives, FIFO eviction).",
                        },
                        name: {
                          type: "string",
                          description:
                            "load_profile/save_profile: name of the named profile.",
                        },
                        description: {
                          type: "string",
                          description:
                            "save_profile: human-readable description of the profile.",
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  {
                    name: "OWNER_FINANCES_DASHBOARD",
                    description:
                      "owner finances dashboard|sources|csv|transactions|spending|recurring|subscription",
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: [],
                      properties: {
                        action: {
                          type: "string",
                          description:
                            'Subaction discriminator (auto-set to "dashboard" for this virtual. do not change).',
                          enum: ["dashboard"],
                          default: "dashboard",
                        },
                        sourceId: {
                          type: "string",
                          description:
                            "Payment source UUID for scoped reads and CSV import.",
                        },
                        kind: {
                          type: "string",
                          description:
                            "add_source kind: csv | plaid | manual | paypal.",
                        },
                        label: {
                          type: "string",
                          description: "Human label when adding a source.",
                        },
                        institution: {
                          type: "string",
                          description: "Institution display name.",
                        },
                        accountMask: {
                          type: "string",
                          description: "Last-four or mask string.",
                        },
                        csvText: {
                          type: "string",
                          description: "Raw CSV payload for import_csv.",
                        },
                        dateColumn: {
                          type: "string",
                          description: "CSV column hint for posting date.",
                        },
                        amountColumn: {
                          type: "string",
                          description: "CSV column hint for amount.",
                        },
                        merchantColumn: {
                          type: "string",
                          description: "CSV column hint for merchant.",
                        },
                        descriptionColumn: {
                          type: "string",
                          description: "CSV column hint for description.",
                        },
                        categoryColumn: {
                          type: "string",
                          description: "CSV column hint for category.",
                        },
                        windowDays: {
                          type: "number",
                          description:
                            "Rolling window for dashboard or spending summaries.",
                        },
                        sinceDays: {
                          type: "number",
                          description:
                            "History window for recurring charge detection.",
                        },
                        limit: {
                          type: "number",
                          description: "Transaction row cap for listings.",
                        },
                        merchantContains: {
                          type: "string",
                          description:
                            "Filter transactions by merchant substring.",
                        },
                        onlyDebits: {
                          type: "boolean",
                          description:
                            "Exclude credits when listing transactions.",
                        },
                        serviceName: {
                          type: "string",
                          description:
                            "Display name of the subscription service.",
                        },
                        serviceSlug: {
                          type: "string",
                          description: "Normalized slug for routing.",
                        },
                        candidateId: {
                          type: "string",
                          description: "Internal audit candidate id.",
                        },
                        cancellationId: {
                          type: "string",
                          description:
                            "Ongoing cancellation id for status lookups.",
                        },
                        executor: {
                          type: "string",
                          description:
                            "Browser executor: user_browser | agent_browser | desktop_native.",
                        },
                        queryWindowDays: {
                          type: "number",
                          description: "Days of history for audit queries.",
                        },
                        confirmed: {
                          type: "boolean",
                          description:
                            "User confirmed cancellation prerequisites.",
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  {
                    name: "OWNER_FINANCES_LIST_SOURCES",
                    description:
                      "owner finances dashboard|sources|csv|transactions|spending|recurring|subscription",
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: [],
                      properties: {
                        action: {
                          type: "string",
                          description:
                            'Subaction discriminator (auto-set to "list_sources" for this virtual. do not change).',
                          enum: ["list_sources"],
                          default: "list_sources",
                        },
                        sourceId: {
                          type: "string",
                          description:
                            "Payment source UUID for scoped reads and CSV import.",
                        },
                        kind: {
                          type: "string",
                          description:
                            "add_source kind: csv | plaid | manual | paypal.",
                        },
                        label: {
                          type: "string",
                          description: "Human label when adding a source.",
                        },
                        institution: {
                          type: "string",
                          description: "Institution display name.",
                        },
                        accountMask: {
                          type: "string",
                          description: "Last-four or mask string.",
                        },
                        csvText: {
                          type: "string",
                          description: "Raw CSV payload for import_csv.",
                        },
                        dateColumn: {
                          type: "string",
                          description: "CSV column hint for posting date.",
                        },
                        amountColumn: {
                          type: "string",
                          description: "CSV column hint for amount.",
                        },
                        merchantColumn: {
                          type: "string",
                          description: "CSV column hint for merchant.",
                        },
                        descriptionColumn: {
                          type: "string",
                          description: "CSV column hint for description.",
                        },
                        categoryColumn: {
                          type: "string",
                          description: "CSV column hint for category.",
                        },
                        windowDays: {
                          type: "number",
                          description:
                            "Rolling window for dashboard or spending summaries.",
                        },
                        sinceDays: {
                          type: "number",
                          description:
                            "History window for recurring charge detection.",
                        },
                        limit: {
                          type: "number",
                          description: "Transaction row cap for listings.",
                        },
                        merchantContains: {
                          type: "string",
                          description:
                            "Filter transactions by merchant substring.",
                        },
                        onlyDebits: {
                          type: "boolean",
                          description:
                            "Exclude credits when listing transactions.",
                        },
                        serviceName: {
                          type: "string",
                          description:
                            "Display name of the subscription service.",
                        },
                        serviceSlug: {
                          type: "string",
                          description: "Normalized slug for routing.",
                        },
                        candidateId: {
                          type: "string",
                          description: "Internal audit candidate id.",
                        },
                        cancellationId: {
                          type: "string",
                          description:
                            "Ongoing cancellation id for status lookups.",
                        },
                        executor: {
                          type: "string",
                          description:
                            "Browser executor: user_browser | agent_browser | desktop_native.",
                        },
                        queryWindowDays: {
                          type: "number",
                          description: "Days of history for audit queries.",
                        },
                        confirmed: {
                          type: "boolean",
                          description:
                            "User confirmed cancellation prerequisites.",
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  {
                    name: "OWNER_FINANCES_ADD_SOURCE",
                    description:
                      "owner finances dashboard|sources|csv|transactions|spending|recurring|subscription",
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: [],
                      properties: {
                        action: {
                          type: "string",
                          description:
                            'Subaction discriminator (auto-set to "add_source" for this virtual. do not change).',
                          enum: ["add_source"],
                          default: "add_source",
                        },
                        sourceId: {
                          type: "string",
                          description:
                            "Payment source UUID for scoped reads and CSV import.",
                        },
                        kind: {
                          type: "string",
                          description:
                            "add_source kind: csv | plaid | manual | paypal.",
                        },
                        label: {
                          type: "string",
                          description: "Human label when adding a source.",
                        },
                        institution: {
                          type: "string",
                          description: "Institution display name.",
                        },
                        accountMask: {
                          type: "string",
                          description: "Last-four or mask string.",
                        },
                        csvText: {
                          type: "string",
                          description: "Raw CSV payload for import_csv.",
                        },
                        dateColumn: {
                          type: "string",
                          description: "CSV column hint for posting date.",
                        },
                        amountColumn: {
                          type: "string",
                          description: "CSV column hint for amount.",
                        },
                        merchantColumn: {
                          type: "string",
                          description: "CSV column hint for merchant.",
                        },
                        descriptionColumn: {
                          type: "string",
                          description: "CSV column hint for description.",
                        },
                        categoryColumn: {
                          type: "string",
                          description: "CSV column hint for category.",
                        },
                        windowDays: {
                          type: "number",
                          description:
                            "Rolling window for dashboard or spending summaries.",
                        },
                        sinceDays: {
                          type: "number",
                          description:
                            "History window for recurring charge detection.",
                        },
                        limit: {
                          type: "number",
                          description: "Transaction row cap for listings.",
                        },
                        merchantContains: {
                          type: "string",
                          description:
                            "Filter transactions by merchant substring.",
                        },
                        onlyDebits: {
                          type: "boolean",
                          description:
                            "Exclude credits when listing transactions.",
                        },
                        serviceName: {
                          type: "string",
                          description:
                            "Display name of the subscription service.",
                        },
                        serviceSlug: {
                          type: "string",
                          description: "Normalized slug for routing.",
                        },
                        candidateId: {
                          type: "string",
                          description: "Internal audit candidate id.",
                        },
                        cancellationId: {
                          type: "string",
                          description:
                            "Ongoing cancellation id for status lookups.",
                        },
                        executor: {
                          type: "string",
                          description:
                            "Browser executor: user_browser | agent_browser | desktop_native.",
                        },
                        queryWindowDays: {
                          type: "number",
                          description: "Days of history for audit queries.",
                        },
                        confirmed: {
                          type: "boolean",
                          description:
                            "User confirmed cancellation prerequisites.",
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  {
                    name: "OWNER_FINANCES_REMOVE_SOURCE",
                    description:
                      "owner finances dashboard|sources|csv|transactions|spending|recurring|subscription",
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: [],
                      properties: {
                        action: {
                          type: "string",
                          description:
                            'Subaction discriminator (auto-set to "remove_source" for this virtual. do not change).',
                          enum: ["remove_source"],
                          default: "remove_source",
                        },
                        sourceId: {
                          type: "string",
                          description:
                            "Payment source UUID for scoped reads and CSV import.",
                        },
                        kind: {
                          type: "string",
                          description:
                            "add_source kind: csv | plaid | manual | paypal.",
                        },
                        label: {
                          type: "string",
                          description: "Human label when adding a source.",
                        },
                        institution: {
                          type: "string",
                          description: "Institution display name.",
                        },
                        accountMask: {
                          type: "string",
                          description: "Last-four or mask string.",
                        },
                        csvText: {
                          type: "string",
                          description: "Raw CSV payload for import_csv.",
                        },
                        dateColumn: {
                          type: "string",
                          description: "CSV column hint for posting date.",
                        },
                        amountColumn: {
                          type: "string",
                          description: "CSV column hint for amount.",
                        },
                        merchantColumn: {
                          type: "string",
                          description: "CSV column hint for merchant.",
                        },
                        descriptionColumn: {
                          type: "string",
                          description: "CSV column hint for description.",
                        },
                        categoryColumn: {
                          type: "string",
                          description: "CSV column hint for category.",
                        },
                        windowDays: {
                          type: "number",
                          description:
                            "Rolling window for dashboard or spending summaries.",
                        },
                        sinceDays: {
                          type: "number",
                          description:
                            "History window for recurring charge detection.",
                        },
                        limit: {
                          type: "number",
                          description: "Transaction row cap for listings.",
                        },
                        merchantContains: {
                          type: "string",
                          description:
                            "Filter transactions by merchant substring.",
                        },
                        onlyDebits: {
                          type: "boolean",
                          description:
                            "Exclude credits when listing transactions.",
                        },
                        serviceName: {
                          type: "string",
                          description:
                            "Display name of the subscription service.",
                        },
                        serviceSlug: {
                          type: "string",
                          description: "Normalized slug for routing.",
                        },
                        candidateId: {
                          type: "string",
                          description: "Internal audit candidate id.",
                        },
                        cancellationId: {
                          type: "string",
                          description:
                            "Ongoing cancellation id for status lookups.",
                        },
                        executor: {
                          type: "string",
                          description:
                            "Browser executor: user_browser | agent_browser | desktop_native.",
                        },
                        queryWindowDays: {
                          type: "number",
                          description: "Days of history for audit queries.",
                        },
                        confirmed: {
                          type: "boolean",
                          description:
                            "User confirmed cancellation prerequisites.",
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  {
                    name: "OWNER_FINANCES_IMPORT_CSV",
                    description:
                      "owner finances dashboard|sources|csv|transactions|spending|recurring|subscription",
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: [],
                      properties: {
                        action: {
                          type: "string",
                          description:
                            'Subaction discriminator (auto-set to "import_csv" for this virtual. do not change).',
                          enum: ["import_csv"],
                          default: "import_csv",
                        },
                        sourceId: {
                          type: "string",
                          description:
                            "Payment source UUID for scoped reads and CSV import.",
                        },
                        kind: {
                          type: "string",
                          description:
                            "add_source kind: csv | plaid | manual | paypal.",
                        },
                        label: {
                          type: "string",
                          description: "Human label when adding a source.",
                        },
                        institution: {
                          type: "string",
                          description: "Institution display name.",
                        },
                        accountMask: {
                          type: "string",
                          description: "Last-four or mask string.",
                        },
                        csvText: {
                          type: "string",
                          description: "Raw CSV payload for import_csv.",
                        },
                        dateColumn: {
                          type: "string",
                          description: "CSV column hint for posting date.",
                        },
                        amountColumn: {
                          type: "string",
                          description: "CSV column hint for amount.",
                        },
                        merchantColumn: {
                          type: "string",
                          description: "CSV column hint for merchant.",
                        },
                        descriptionColumn: {
                          type: "string",
                          description: "CSV column hint for description.",
                        },
                        categoryColumn: {
                          type: "string",
                          description: "CSV column hint for category.",
                        },
                        windowDays: {
                          type: "number",
                          description:
                            "Rolling window for dashboard or spending summaries.",
                        },
                        sinceDays: {
                          type: "number",
                          description:
                            "History window for recurring charge detection.",
                        },
                        limit: {
                          type: "number",
                          description: "Transaction row cap for listings.",
                        },
                        merchantContains: {
                          type: "string",
                          description:
                            "Filter transactions by merchant substring.",
                        },
                        onlyDebits: {
                          type: "boolean",
                          description:
                            "Exclude credits when listing transactions.",
                        },
                        serviceName: {
                          type: "string",
                          description:
                            "Display name of the subscription service.",
                        },
                        serviceSlug: {
                          type: "string",
                          description: "Normalized slug for routing.",
                        },
                        candidateId: {
                          type: "string",
                          description: "Internal audit candidate id.",
                        },
                        cancellationId: {
                          type: "string",
                          description:
                            "Ongoing cancellation id for status lookups.",
                        },
                        executor: {
                          type: "string",
                          description:
                            "Browser executor: user_browser | agent_browser | desktop_native.",
                        },
                        queryWindowDays: {
                          type: "number",
                          description: "Days of history for audit queries.",
                        },
                        confirmed: {
                          type: "boolean",
                          description:
                            "User confirmed cancellation prerequisites.",
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  {
                    name: "OWNER_FINANCES_LIST_TRANSACTIONS",
                    description:
                      "owner finances dashboard|sources|csv|transactions|spending|recurring|subscription",
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: [],
                      properties: {
                        action: {
                          type: "string",
                          description:
                            'Subaction discriminator (auto-set to "list_transactions" for this virtual. do not change).',
                          enum: ["list_transactions"],
                          default: "list_transactions",
                        },
                        sourceId: {
                          type: "string",
                          description:
                            "Payment source UUID for scoped reads and CSV import.",
                        },
                        kind: {
                          type: "string",
                          description:
                            "add_source kind: csv | plaid | manual | paypal.",
                        },
                        label: {
                          type: "string",
                          description: "Human label when adding a source.",
                        },
                        institution: {
                          type: "string",
                          description: "Institution display name.",
                        },
                        accountMask: {
                          type: "string",
                          description: "Last-four or mask string.",
                        },
                        csvText: {
                          type: "string",
                          description: "Raw CSV payload for import_csv.",
                        },
                        dateColumn: {
                          type: "string",
                          description: "CSV column hint for posting date.",
                        },
                        amountColumn: {
                          type: "string",
                          description: "CSV column hint for amount.",
                        },
                        merchantColumn: {
                          type: "string",
                          description: "CSV column hint for merchant.",
                        },
                        descriptionColumn: {
                          type: "string",
                          description: "CSV column hint for description.",
                        },
                        categoryColumn: {
                          type: "string",
                          description: "CSV column hint for category.",
                        },
                        windowDays: {
                          type: "number",
                          description:
                            "Rolling window for dashboard or spending summaries.",
                        },
                        sinceDays: {
                          type: "number",
                          description:
                            "History window for recurring charge detection.",
                        },
                        limit: {
                          type: "number",
                          description: "Transaction row cap for listings.",
                        },
                        merchantContains: {
                          type: "string",
                          description:
                            "Filter transactions by merchant substring.",
                        },
                        onlyDebits: {
                          type: "boolean",
                          description:
                            "Exclude credits when listing transactions.",
                        },
                        serviceName: {
                          type: "string",
                          description:
                            "Display name of the subscription service.",
                        },
                        serviceSlug: {
                          type: "string",
                          description: "Normalized slug for routing.",
                        },
                        candidateId: {
                          type: "string",
                          description: "Internal audit candidate id.",
                        },
                        cancellationId: {
                          type: "string",
                          description:
                            "Ongoing cancellation id for status lookups.",
                        },
                        executor: {
                          type: "string",
                          description:
                            "Browser executor: user_browser | agent_browser | desktop_native.",
                        },
                        queryWindowDays: {
                          type: "number",
                          description: "Days of history for audit queries.",
                        },
                        confirmed: {
                          type: "boolean",
                          description:
                            "User confirmed cancellation prerequisites.",
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  {
                    name: "OWNER_FINANCES_RECURRING_CHARGES",
                    description:
                      "owner finances dashboard|sources|csv|transactions|spending|recurring|subscription",
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: [],
                      properties: {
                        action: {
                          type: "string",
                          description:
                            'Subaction discriminator (auto-set to "recurring_charges" for this virtual. do not change).',
                          enum: ["recurring_charges"],
                          default: "recurring_charges",
                        },
                        sourceId: {
                          type: "string",
                          description:
                            "Payment source UUID for scoped reads and CSV import.",
                        },
                        kind: {
                          type: "string",
                          description:
                            "add_source kind: csv | plaid | manual | paypal.",
                        },
                        label: {
                          type: "string",
                          description: "Human label when adding a source.",
                        },
                        institution: {
                          type: "string",
                          description: "Institution display name.",
                        },
                        accountMask: {
                          type: "string",
                          description: "Last-four or mask string.",
                        },
                        csvText: {
                          type: "string",
                          description: "Raw CSV payload for import_csv.",
                        },
                        dateColumn: {
                          type: "string",
                          description: "CSV column hint for posting date.",
                        },
                        amountColumn: {
                          type: "string",
                          description: "CSV column hint for amount.",
                        },
                        merchantColumn: {
                          type: "string",
                          description: "CSV column hint for merchant.",
                        },
                        descriptionColumn: {
                          type: "string",
                          description: "CSV column hint for description.",
                        },
                        categoryColumn: {
                          type: "string",
                          description: "CSV column hint for category.",
                        },
                        windowDays: {
                          type: "number",
                          description:
                            "Rolling window for dashboard or spending summaries.",
                        },
                        sinceDays: {
                          type: "number",
                          description:
                            "History window for recurring charge detection.",
                        },
                        limit: {
                          type: "number",
                          description: "Transaction row cap for listings.",
                        },
                        merchantContains: {
                          type: "string",
                          description:
                            "Filter transactions by merchant substring.",
                        },
                        onlyDebits: {
                          type: "boolean",
                          description:
                            "Exclude credits when listing transactions.",
                        },
                        serviceName: {
                          type: "string",
                          description:
                            "Display name of the subscription service.",
                        },
                        serviceSlug: {
                          type: "string",
                          description: "Normalized slug for routing.",
                        },
                        candidateId: {
                          type: "string",
                          description: "Internal audit candidate id.",
                        },
                        cancellationId: {
                          type: "string",
                          description:
                            "Ongoing cancellation id for status lookups.",
                        },
                        executor: {
                          type: "string",
                          description:
                            "Browser executor: user_browser | agent_browser | desktop_native.",
                        },
                        queryWindowDays: {
                          type: "number",
                          description: "Days of history for audit queries.",
                        },
                        confirmed: {
                          type: "boolean",
                          description:
                            "User confirmed cancellation prerequisites.",
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  {
                    name: "CALENDAR",
                    description:
                      "calendar feed|next|search|create|update|delete|trip_window|reschedule|availability|propose",
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: [],
                      properties: {
                        action: {
                          type: "string",
                          description:
                            "Calendar op. feed, next_event, search_events, create_event, update_event, delete_event, trip_window, bulk_reschedule, check_availability, propose_times...",
                          enum: [
                            "feed",
                            "next_event",
                            "search_events",
                            "create_event",
                            "update_event",
                            "delete_event",
                            "trip_window",
                            "bulk_reschedule",
                            "check_availability",
                            "propose_times",
                            "update_preferences",
                          ],
                        },
                        intent: {
                          type: "string",
                          description:
                            'Natural-language request. Examples: "calendar today", "flights this week", "create meeting tomorrow 3pm".',
                        },
                        title: {
                          type: "string",
                          description:
                            "title TOP-LEVEL; NOT details. create_event needs title + details.start/end",
                        },
                        query: {
                          type: "string",
                          description:
                            "Search phrase for search_events/travel_itinerary: flight, dentist, Denver.",
                        },
                        queries: {
                          type: "array",
                          description:
                            "Optional search_events phrases array. Combined/deduped.",
                          items: { type: "string" },
                        },
                        details: {
                          type: "object",
                          description:
                            "details create|update|delete: calendarId,start/end,eventId,location; title/window TOP",
                          required: [],
                          properties: {
                            calendarId: { type: "string" },
                            timeMin: { type: "string" },
                            timeMax: { type: "string" },
                            timeZone: { type: "string" },
                            forceSync: { type: "boolean" },
                            windowDays: { type: "number" },
                            windowPreset: { type: "string" },
                            start: { type: "string" },
                            end: { type: "string" },
                            startAt: { type: "string" },
                            endAt: { type: "string" },
                            durationMinutes: { type: "number" },
                            eventId: { type: "string" },
                            newTitle: { type: "string" },
                            description: { type: "string" },
                            location: { type: "string" },
                            travelOriginAddress: { type: "string" },
                            attendees: {
                              type: "array",
                              items: { type: "string" },
                            },
                          },
                          additionalProperties: false,
                        },
                        durationMinutes: {
                          type: "number",
                          description:
                            "TOP-LEVEL flat. propose_times length minutes. Example: `{ subaction: 'propose_times', durationMinutes: 30, slotCount: 3, windowStart: '...', windowEnd: '...'...",
                        },
                        daysAhead: {
                          type: "number",
                          description:
                            "propose_times days ahead. Default 7. Ignored with windowStart/windowEnd.",
                        },
                        slotCount: {
                          type: "number",
                          description: "propose_times slot count. Default 3.",
                        },
                        windowStart: {
                          type: "string",
                          description:
                            "propose_times window earliest start. ISO-8601.",
                        },
                        windowEnd: {
                          type: "string",
                          description:
                            "propose_times window latest end. ISO-8601.",
                        },
                        startAt: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat. check_availability start. ISO-8601. Example: `{ subaction: 'check_availability', startAt: '2026-05-14T09:00:00Z', endAt...",
                        },
                        endAt: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat. check_availability end. ISO-8601. See `startAt`.",
                        },
                        timeZone: {
                          type: "string",
                          description:
                            "IANA timeZone for update_preferences hours.",
                        },
                        preferredStartLocal: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat for update_preferences. Earliest start local HH:MM 24h. Example: `{ subaction: 'update_preferences', preferredStartLocal: '09:00'...",
                        },
                        preferredEndLocal: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat for update_preferences. Latest end local HH:MM 24h. See `preferredStartLocal`.",
                        },
                        defaultDurationMinutes: {
                          type: "number",
                          description: "Default duration minutes (5-480).",
                        },
                        travelBufferMinutes: {
                          type: "number",
                          description:
                            "Buffer minutes before/after meetings (0-240).",
                        },
                        blackoutWindows: {
                          type: "array",
                          description:
                            "blackoutWindows[]: label startLocal HH:MM endLocal HH:MM daysOfWeek?[0..6]",
                          items: {
                            type: "object",
                            required: ["label", "startLocal", "endLocal"],
                            properties: {
                              label: { type: "string" },
                              startLocal: {
                                type: "string",
                                pattern: "^[0-2][0-9]:[0-5][0-9]$",
                              },
                              endLocal: {
                                type: "string",
                                pattern: "^[0-2][0-9]:[0-5][0-9]$",
                              },
                              daysOfWeek: {
                                type: "array",
                                items: {
                                  type: "number",
                                  minimum: 0,
                                  maximum: 6,
                                },
                              },
                            },
                            additionalProperties: false,
                          },
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  {
                    name: "CALENDAR_FEED",
                    description:
                      "calendar feed|next|search|create|update|delete|trip_window|reschedule|availability|propose",
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: [],
                      properties: {
                        action: {
                          type: "string",
                          description:
                            'Subaction discriminator (auto-set to "feed" for this virtual. do not change).',
                          enum: ["feed"],
                          default: "feed",
                        },
                        intent: {
                          type: "string",
                          description:
                            'Natural-language request. Examples: "calendar today", "flights this week", "create meeting tomorrow 3pm".',
                        },
                        title: {
                          type: "string",
                          description:
                            "title TOP-LEVEL; NOT details. create_event needs title + details.start/end",
                        },
                        query: {
                          type: "string",
                          description:
                            "Search phrase for search_events/travel_itinerary: flight, dentist, Denver.",
                        },
                        queries: {
                          type: "array",
                          description:
                            "Optional search_events phrases array. Combined/deduped.",
                          items: { type: "string" },
                        },
                        details: {
                          type: "object",
                          description:
                            "details create|update|delete: calendarId,start/end,eventId,location; title/window TOP",
                          required: [],
                          properties: {
                            calendarId: { type: "string" },
                            timeMin: { type: "string" },
                            timeMax: { type: "string" },
                            timeZone: { type: "string" },
                            forceSync: { type: "boolean" },
                            windowDays: { type: "number" },
                            windowPreset: { type: "string" },
                            start: { type: "string" },
                            end: { type: "string" },
                            startAt: { type: "string" },
                            endAt: { type: "string" },
                            durationMinutes: { type: "number" },
                            eventId: { type: "string" },
                            newTitle: { type: "string" },
                            description: { type: "string" },
                            location: { type: "string" },
                            travelOriginAddress: { type: "string" },
                            attendees: {
                              type: "array",
                              items: { type: "string" },
                            },
                          },
                          additionalProperties: false,
                        },
                        durationMinutes: {
                          type: "number",
                          description:
                            "TOP-LEVEL flat. propose_times length minutes. Example: `{ subaction: 'propose_times', durationMinutes: 30, slotCount: 3, windowStart: '...', windowEnd: '...'...",
                        },
                        daysAhead: {
                          type: "number",
                          description:
                            "propose_times days ahead. Default 7. Ignored with windowStart/windowEnd.",
                        },
                        slotCount: {
                          type: "number",
                          description: "propose_times slot count. Default 3.",
                        },
                        windowStart: {
                          type: "string",
                          description:
                            "propose_times window earliest start. ISO-8601.",
                        },
                        windowEnd: {
                          type: "string",
                          description:
                            "propose_times window latest end. ISO-8601.",
                        },
                        startAt: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat. check_availability start. ISO-8601. Example: `{ subaction: 'check_availability', startAt: '2026-05-14T09:00:00Z', endAt...",
                        },
                        endAt: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat. check_availability end. ISO-8601. See `startAt`.",
                        },
                        timeZone: {
                          type: "string",
                          description:
                            "IANA timeZone for update_preferences hours.",
                        },
                        preferredStartLocal: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat for update_preferences. Earliest start local HH:MM 24h. Example: `{ subaction: 'update_preferences', preferredStartLocal: '09:00'...",
                        },
                        preferredEndLocal: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat for update_preferences. Latest end local HH:MM 24h. See `preferredStartLocal`.",
                        },
                        defaultDurationMinutes: {
                          type: "number",
                          description: "Default duration minutes (5-480).",
                        },
                        travelBufferMinutes: {
                          type: "number",
                          description:
                            "Buffer minutes before/after meetings (0-240).",
                        },
                        blackoutWindows: {
                          type: "array",
                          description:
                            "blackoutWindows[]: label startLocal HH:MM endLocal HH:MM daysOfWeek?[0..6]",
                          items: {
                            type: "object",
                            required: ["label", "startLocal", "endLocal"],
                            properties: {
                              label: { type: "string" },
                              startLocal: {
                                type: "string",
                                pattern: "^[0-2][0-9]:[0-5][0-9]$",
                              },
                              endLocal: {
                                type: "string",
                                pattern: "^[0-2][0-9]:[0-5][0-9]$",
                              },
                              daysOfWeek: {
                                type: "array",
                                items: {
                                  type: "number",
                                  minimum: 0,
                                  maximum: 6,
                                },
                              },
                            },
                            additionalProperties: false,
                          },
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  {
                    name: "CALENDAR_NEXT_EVENT",
                    description:
                      "calendar feed|next|search|create|update|delete|trip_window|reschedule|availability|propose",
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: [],
                      properties: {
                        action: {
                          type: "string",
                          description:
                            'Subaction discriminator (auto-set to "next_event" for this virtual. do not change).',
                          enum: ["next_event"],
                          default: "next_event",
                        },
                        intent: {
                          type: "string",
                          description:
                            'Natural-language request. Examples: "calendar today", "flights this week", "create meeting tomorrow 3pm".',
                        },
                        title: {
                          type: "string",
                          description:
                            "title TOP-LEVEL; NOT details. create_event needs title + details.start/end",
                        },
                        query: {
                          type: "string",
                          description:
                            "Search phrase for search_events/travel_itinerary: flight, dentist, Denver.",
                        },
                        queries: {
                          type: "array",
                          description:
                            "Optional search_events phrases array. Combined/deduped.",
                          items: { type: "string" },
                        },
                        details: {
                          type: "object",
                          description:
                            "details create|update|delete: calendarId,start/end,eventId,location; title/window TOP",
                          required: [],
                          properties: {
                            calendarId: { type: "string" },
                            timeMin: { type: "string" },
                            timeMax: { type: "string" },
                            timeZone: { type: "string" },
                            forceSync: { type: "boolean" },
                            windowDays: { type: "number" },
                            windowPreset: { type: "string" },
                            start: { type: "string" },
                            end: { type: "string" },
                            startAt: { type: "string" },
                            endAt: { type: "string" },
                            durationMinutes: { type: "number" },
                            eventId: { type: "string" },
                            newTitle: { type: "string" },
                            description: { type: "string" },
                            location: { type: "string" },
                            travelOriginAddress: { type: "string" },
                            attendees: {
                              type: "array",
                              items: { type: "string" },
                            },
                          },
                          additionalProperties: false,
                        },
                        durationMinutes: {
                          type: "number",
                          description:
                            "TOP-LEVEL flat. propose_times length minutes. Example: `{ subaction: 'propose_times', durationMinutes: 30, slotCount: 3, windowStart: '...', windowEnd: '...'...",
                        },
                        daysAhead: {
                          type: "number",
                          description:
                            "propose_times days ahead. Default 7. Ignored with windowStart/windowEnd.",
                        },
                        slotCount: {
                          type: "number",
                          description: "propose_times slot count. Default 3.",
                        },
                        windowStart: {
                          type: "string",
                          description:
                            "propose_times window earliest start. ISO-8601.",
                        },
                        windowEnd: {
                          type: "string",
                          description:
                            "propose_times window latest end. ISO-8601.",
                        },
                        startAt: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat. check_availability start. ISO-8601. Example: `{ subaction: 'check_availability', startAt: '2026-05-14T09:00:00Z', endAt...",
                        },
                        endAt: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat. check_availability end. ISO-8601. See `startAt`.",
                        },
                        timeZone: {
                          type: "string",
                          description:
                            "IANA timeZone for update_preferences hours.",
                        },
                        preferredStartLocal: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat for update_preferences. Earliest start local HH:MM 24h. Example: `{ subaction: 'update_preferences', preferredStartLocal: '09:00'...",
                        },
                        preferredEndLocal: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat for update_preferences. Latest end local HH:MM 24h. See `preferredStartLocal`.",
                        },
                        defaultDurationMinutes: {
                          type: "number",
                          description: "Default duration minutes (5-480).",
                        },
                        travelBufferMinutes: {
                          type: "number",
                          description:
                            "Buffer minutes before/after meetings (0-240).",
                        },
                        blackoutWindows: {
                          type: "array",
                          description:
                            "blackoutWindows[]: label startLocal HH:MM endLocal HH:MM daysOfWeek?[0..6]",
                          items: {
                            type: "object",
                            required: ["label", "startLocal", "endLocal"],
                            properties: {
                              label: { type: "string" },
                              startLocal: {
                                type: "string",
                                pattern: "^[0-2][0-9]:[0-5][0-9]$",
                              },
                              endLocal: {
                                type: "string",
                                pattern: "^[0-2][0-9]:[0-5][0-9]$",
                              },
                              daysOfWeek: {
                                type: "array",
                                items: {
                                  type: "number",
                                  minimum: 0,
                                  maximum: 6,
                                },
                              },
                            },
                            additionalProperties: false,
                          },
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  {
                    name: "CALENDAR_SEARCH_EVENTS",
                    description:
                      "calendar feed|next|search|create|update|delete|trip_window|reschedule|availability|propose",
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: [],
                      properties: {
                        action: {
                          type: "string",
                          description:
                            'Subaction discriminator (auto-set to "search_events" for this virtual. do not change).',
                          enum: ["search_events"],
                          default: "search_events",
                        },
                        intent: {
                          type: "string",
                          description:
                            'Natural-language request. Examples: "calendar today", "flights this week", "create meeting tomorrow 3pm".',
                        },
                        title: {
                          type: "string",
                          description:
                            "title TOP-LEVEL; NOT details. create_event needs title + details.start/end",
                        },
                        query: {
                          type: "string",
                          description:
                            "Search phrase for search_events/travel_itinerary: flight, dentist, Denver.",
                        },
                        queries: {
                          type: "array",
                          description:
                            "Optional search_events phrases array. Combined/deduped.",
                          items: { type: "string" },
                        },
                        details: {
                          type: "object",
                          description:
                            "details create|update|delete: calendarId,start/end,eventId,location; title/window TOP",
                          required: [],
                          properties: {
                            calendarId: { type: "string" },
                            timeMin: { type: "string" },
                            timeMax: { type: "string" },
                            timeZone: { type: "string" },
                            forceSync: { type: "boolean" },
                            windowDays: { type: "number" },
                            windowPreset: { type: "string" },
                            start: { type: "string" },
                            end: { type: "string" },
                            startAt: { type: "string" },
                            endAt: { type: "string" },
                            durationMinutes: { type: "number" },
                            eventId: { type: "string" },
                            newTitle: { type: "string" },
                            description: { type: "string" },
                            location: { type: "string" },
                            travelOriginAddress: { type: "string" },
                            attendees: {
                              type: "array",
                              items: { type: "string" },
                            },
                          },
                          additionalProperties: false,
                        },
                        durationMinutes: {
                          type: "number",
                          description:
                            "TOP-LEVEL flat. propose_times length minutes. Example: `{ subaction: 'propose_times', durationMinutes: 30, slotCount: 3, windowStart: '...', windowEnd: '...'...",
                        },
                        daysAhead: {
                          type: "number",
                          description:
                            "propose_times days ahead. Default 7. Ignored with windowStart/windowEnd.",
                        },
                        slotCount: {
                          type: "number",
                          description: "propose_times slot count. Default 3.",
                        },
                        windowStart: {
                          type: "string",
                          description:
                            "propose_times window earliest start. ISO-8601.",
                        },
                        windowEnd: {
                          type: "string",
                          description:
                            "propose_times window latest end. ISO-8601.",
                        },
                        startAt: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat. check_availability start. ISO-8601. Example: `{ subaction: 'check_availability', startAt: '2026-05-14T09:00:00Z', endAt...",
                        },
                        endAt: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat. check_availability end. ISO-8601. See `startAt`.",
                        },
                        timeZone: {
                          type: "string",
                          description:
                            "IANA timeZone for update_preferences hours.",
                        },
                        preferredStartLocal: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat for update_preferences. Earliest start local HH:MM 24h. Example: `{ subaction: 'update_preferences', preferredStartLocal: '09:00'...",
                        },
                        preferredEndLocal: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat for update_preferences. Latest end local HH:MM 24h. See `preferredStartLocal`.",
                        },
                        defaultDurationMinutes: {
                          type: "number",
                          description: "Default duration minutes (5-480).",
                        },
                        travelBufferMinutes: {
                          type: "number",
                          description:
                            "Buffer minutes before/after meetings (0-240).",
                        },
                        blackoutWindows: {
                          type: "array",
                          description:
                            "blackoutWindows[]: label startLocal HH:MM endLocal HH:MM daysOfWeek?[0..6]",
                          items: {
                            type: "object",
                            required: ["label", "startLocal", "endLocal"],
                            properties: {
                              label: { type: "string" },
                              startLocal: {
                                type: "string",
                                pattern: "^[0-2][0-9]:[0-5][0-9]$",
                              },
                              endLocal: {
                                type: "string",
                                pattern: "^[0-2][0-9]:[0-5][0-9]$",
                              },
                              daysOfWeek: {
                                type: "array",
                                items: {
                                  type: "number",
                                  minimum: 0,
                                  maximum: 6,
                                },
                              },
                            },
                            additionalProperties: false,
                          },
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  {
                    name: "CALENDAR_CREATE_EVENT",
                    description:
                      "calendar feed|next|search|create|update|delete|trip_window|reschedule|availability|propose",
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: [],
                      properties: {
                        action: {
                          type: "string",
                          description:
                            'Subaction discriminator (auto-set to "create_event" for this virtual. do not change).',
                          enum: ["create_event"],
                          default: "create_event",
                        },
                        intent: {
                          type: "string",
                          description:
                            'Natural-language request. Examples: "calendar today", "flights this week", "create meeting tomorrow 3pm".',
                        },
                        title: {
                          type: "string",
                          description:
                            "title TOP-LEVEL; NOT details. create_event needs title + details.start/end",
                        },
                        query: {
                          type: "string",
                          description:
                            "Search phrase for search_events/travel_itinerary: flight, dentist, Denver.",
                        },
                        queries: {
                          type: "array",
                          description:
                            "Optional search_events phrases array. Combined/deduped.",
                          items: { type: "string" },
                        },
                        details: {
                          type: "object",
                          description:
                            "details create|update|delete: calendarId,start/end,eventId,location; title/window TOP",
                          required: [],
                          properties: {
                            calendarId: { type: "string" },
                            timeMin: { type: "string" },
                            timeMax: { type: "string" },
                            timeZone: { type: "string" },
                            forceSync: { type: "boolean" },
                            windowDays: { type: "number" },
                            windowPreset: { type: "string" },
                            start: { type: "string" },
                            end: { type: "string" },
                            startAt: { type: "string" },
                            endAt: { type: "string" },
                            durationMinutes: { type: "number" },
                            eventId: { type: "string" },
                            newTitle: { type: "string" },
                            description: { type: "string" },
                            location: { type: "string" },
                            travelOriginAddress: { type: "string" },
                            attendees: {
                              type: "array",
                              items: { type: "string" },
                            },
                          },
                          additionalProperties: false,
                        },
                        durationMinutes: {
                          type: "number",
                          description:
                            "TOP-LEVEL flat. propose_times length minutes. Example: `{ subaction: 'propose_times', durationMinutes: 30, slotCount: 3, windowStart: '...', windowEnd: '...'...",
                        },
                        daysAhead: {
                          type: "number",
                          description:
                            "propose_times days ahead. Default 7. Ignored with windowStart/windowEnd.",
                        },
                        slotCount: {
                          type: "number",
                          description: "propose_times slot count. Default 3.",
                        },
                        windowStart: {
                          type: "string",
                          description:
                            "propose_times window earliest start. ISO-8601.",
                        },
                        windowEnd: {
                          type: "string",
                          description:
                            "propose_times window latest end. ISO-8601.",
                        },
                        startAt: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat. check_availability start. ISO-8601. Example: `{ subaction: 'check_availability', startAt: '2026-05-14T09:00:00Z', endAt...",
                        },
                        endAt: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat. check_availability end. ISO-8601. See `startAt`.",
                        },
                        timeZone: {
                          type: "string",
                          description:
                            "IANA timeZone for update_preferences hours.",
                        },
                        preferredStartLocal: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat for update_preferences. Earliest start local HH:MM 24h. Example: `{ subaction: 'update_preferences', preferredStartLocal: '09:00'...",
                        },
                        preferredEndLocal: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat for update_preferences. Latest end local HH:MM 24h. See `preferredStartLocal`.",
                        },
                        defaultDurationMinutes: {
                          type: "number",
                          description: "Default duration minutes (5-480).",
                        },
                        travelBufferMinutes: {
                          type: "number",
                          description:
                            "Buffer minutes before/after meetings (0-240).",
                        },
                        blackoutWindows: {
                          type: "array",
                          description:
                            "blackoutWindows[]: label startLocal HH:MM endLocal HH:MM daysOfWeek?[0..6]",
                          items: {
                            type: "object",
                            required: ["label", "startLocal", "endLocal"],
                            properties: {
                              label: { type: "string" },
                              startLocal: {
                                type: "string",
                                pattern: "^[0-2][0-9]:[0-5][0-9]$",
                              },
                              endLocal: {
                                type: "string",
                                pattern: "^[0-2][0-9]:[0-5][0-9]$",
                              },
                              daysOfWeek: {
                                type: "array",
                                items: {
                                  type: "number",
                                  minimum: 0,
                                  maximum: 6,
                                },
                              },
                            },
                            additionalProperties: false,
                          },
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  {
                    name: "CALENDAR_UPDATE_EVENT",
                    description:
                      "calendar feed|next|search|create|update|delete|trip_window|reschedule|availability|propose",
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: [],
                      properties: {
                        action: {
                          type: "string",
                          description:
                            'Subaction discriminator (auto-set to "update_event" for this virtual. do not change).',
                          enum: ["update_event"],
                          default: "update_event",
                        },
                        intent: {
                          type: "string",
                          description:
                            'Natural-language request. Examples: "calendar today", "flights this week", "create meeting tomorrow 3pm".',
                        },
                        title: {
                          type: "string",
                          description:
                            "title TOP-LEVEL; NOT details. create_event needs title + details.start/end",
                        },
                        query: {
                          type: "string",
                          description:
                            "Search phrase for search_events/travel_itinerary: flight, dentist, Denver.",
                        },
                        queries: {
                          type: "array",
                          description:
                            "Optional search_events phrases array. Combined/deduped.",
                          items: { type: "string" },
                        },
                        details: {
                          type: "object",
                          description:
                            "details create|update|delete: calendarId,start/end,eventId,location; title/window TOP",
                          required: [],
                          properties: {
                            calendarId: { type: "string" },
                            timeMin: { type: "string" },
                            timeMax: { type: "string" },
                            timeZone: { type: "string" },
                            forceSync: { type: "boolean" },
                            windowDays: { type: "number" },
                            windowPreset: { type: "string" },
                            start: { type: "string" },
                            end: { type: "string" },
                            startAt: { type: "string" },
                            endAt: { type: "string" },
                            durationMinutes: { type: "number" },
                            eventId: { type: "string" },
                            newTitle: { type: "string" },
                            description: { type: "string" },
                            location: { type: "string" },
                            travelOriginAddress: { type: "string" },
                            attendees: {
                              type: "array",
                              items: { type: "string" },
                            },
                          },
                          additionalProperties: false,
                        },
                        durationMinutes: {
                          type: "number",
                          description:
                            "TOP-LEVEL flat. propose_times length minutes. Example: `{ subaction: 'propose_times', durationMinutes: 30, slotCount: 3, windowStart: '...', windowEnd: '...'...",
                        },
                        daysAhead: {
                          type: "number",
                          description:
                            "propose_times days ahead. Default 7. Ignored with windowStart/windowEnd.",
                        },
                        slotCount: {
                          type: "number",
                          description: "propose_times slot count. Default 3.",
                        },
                        windowStart: {
                          type: "string",
                          description:
                            "propose_times window earliest start. ISO-8601.",
                        },
                        windowEnd: {
                          type: "string",
                          description:
                            "propose_times window latest end. ISO-8601.",
                        },
                        startAt: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat. check_availability start. ISO-8601. Example: `{ subaction: 'check_availability', startAt: '2026-05-14T09:00:00Z', endAt...",
                        },
                        endAt: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat. check_availability end. ISO-8601. See `startAt`.",
                        },
                        timeZone: {
                          type: "string",
                          description:
                            "IANA timeZone for update_preferences hours.",
                        },
                        preferredStartLocal: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat for update_preferences. Earliest start local HH:MM 24h. Example: `{ subaction: 'update_preferences', preferredStartLocal: '09:00'...",
                        },
                        preferredEndLocal: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat for update_preferences. Latest end local HH:MM 24h. See `preferredStartLocal`.",
                        },
                        defaultDurationMinutes: {
                          type: "number",
                          description: "Default duration minutes (5-480).",
                        },
                        travelBufferMinutes: {
                          type: "number",
                          description:
                            "Buffer minutes before/after meetings (0-240).",
                        },
                        blackoutWindows: {
                          type: "array",
                          description:
                            "blackoutWindows[]: label startLocal HH:MM endLocal HH:MM daysOfWeek?[0..6]",
                          items: {
                            type: "object",
                            required: ["label", "startLocal", "endLocal"],
                            properties: {
                              label: { type: "string" },
                              startLocal: {
                                type: "string",
                                pattern: "^[0-2][0-9]:[0-5][0-9]$",
                              },
                              endLocal: {
                                type: "string",
                                pattern: "^[0-2][0-9]:[0-5][0-9]$",
                              },
                              daysOfWeek: {
                                type: "array",
                                items: {
                                  type: "number",
                                  minimum: 0,
                                  maximum: 6,
                                },
                              },
                            },
                            additionalProperties: false,
                          },
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  {
                    name: "CALENDAR_DELETE_EVENT",
                    description:
                      "calendar feed|next|search|create|update|delete|trip_window|reschedule|availability|propose",
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: [],
                      properties: {
                        action: {
                          type: "string",
                          description:
                            'Subaction discriminator (auto-set to "delete_event" for this virtual. do not change).',
                          enum: ["delete_event"],
                          default: "delete_event",
                        },
                        intent: {
                          type: "string",
                          description:
                            'Natural-language request. Examples: "calendar today", "flights this week", "create meeting tomorrow 3pm".',
                        },
                        title: {
                          type: "string",
                          description:
                            "title TOP-LEVEL; NOT details. create_event needs title + details.start/end",
                        },
                        query: {
                          type: "string",
                          description:
                            "Search phrase for search_events/travel_itinerary: flight, dentist, Denver.",
                        },
                        queries: {
                          type: "array",
                          description:
                            "Optional search_events phrases array. Combined/deduped.",
                          items: { type: "string" },
                        },
                        details: {
                          type: "object",
                          description:
                            "details create|update|delete: calendarId,start/end,eventId,location; title/window TOP",
                          required: [],
                          properties: {
                            calendarId: { type: "string" },
                            timeMin: { type: "string" },
                            timeMax: { type: "string" },
                            timeZone: { type: "string" },
                            forceSync: { type: "boolean" },
                            windowDays: { type: "number" },
                            windowPreset: { type: "string" },
                            start: { type: "string" },
                            end: { type: "string" },
                            startAt: { type: "string" },
                            endAt: { type: "string" },
                            durationMinutes: { type: "number" },
                            eventId: { type: "string" },
                            newTitle: { type: "string" },
                            description: { type: "string" },
                            location: { type: "string" },
                            travelOriginAddress: { type: "string" },
                            attendees: {
                              type: "array",
                              items: { type: "string" },
                            },
                          },
                          additionalProperties: false,
                        },
                        durationMinutes: {
                          type: "number",
                          description:
                            "TOP-LEVEL flat. propose_times length minutes. Example: `{ subaction: 'propose_times', durationMinutes: 30, slotCount: 3, windowStart: '...', windowEnd: '...'...",
                        },
                        daysAhead: {
                          type: "number",
                          description:
                            "propose_times days ahead. Default 7. Ignored with windowStart/windowEnd.",
                        },
                        slotCount: {
                          type: "number",
                          description: "propose_times slot count. Default 3.",
                        },
                        windowStart: {
                          type: "string",
                          description:
                            "propose_times window earliest start. ISO-8601.",
                        },
                        windowEnd: {
                          type: "string",
                          description:
                            "propose_times window latest end. ISO-8601.",
                        },
                        startAt: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat. check_availability start. ISO-8601. Example: `{ subaction: 'check_availability', startAt: '2026-05-14T09:00:00Z', endAt...",
                        },
                        endAt: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat. check_availability end. ISO-8601. See `startAt`.",
                        },
                        timeZone: {
                          type: "string",
                          description:
                            "IANA timeZone for update_preferences hours.",
                        },
                        preferredStartLocal: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat for update_preferences. Earliest start local HH:MM 24h. Example: `{ subaction: 'update_preferences', preferredStartLocal: '09:00'...",
                        },
                        preferredEndLocal: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat for update_preferences. Latest end local HH:MM 24h. See `preferredStartLocal`.",
                        },
                        defaultDurationMinutes: {
                          type: "number",
                          description: "Default duration minutes (5-480).",
                        },
                        travelBufferMinutes: {
                          type: "number",
                          description:
                            "Buffer minutes before/after meetings (0-240).",
                        },
                        blackoutWindows: {
                          type: "array",
                          description:
                            "blackoutWindows[]: label startLocal HH:MM endLocal HH:MM daysOfWeek?[0..6]",
                          items: {
                            type: "object",
                            required: ["label", "startLocal", "endLocal"],
                            properties: {
                              label: { type: "string" },
                              startLocal: {
                                type: "string",
                                pattern: "^[0-2][0-9]:[0-5][0-9]$",
                              },
                              endLocal: {
                                type: "string",
                                pattern: "^[0-2][0-9]:[0-5][0-9]$",
                              },
                              daysOfWeek: {
                                type: "array",
                                items: {
                                  type: "number",
                                  minimum: 0,
                                  maximum: 6,
                                },
                              },
                            },
                            additionalProperties: false,
                          },
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  {
                    name: "CALENDAR_TRIP_WINDOW",
                    description:
                      "calendar feed|next|search|create|update|delete|trip_window|reschedule|availability|propose",
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: [],
                      properties: {
                        action: {
                          type: "string",
                          description:
                            'Subaction discriminator (auto-set to "trip_window" for this virtual. do not change).',
                          enum: ["trip_window"],
                          default: "trip_window",
                        },
                        intent: {
                          type: "string",
                          description:
                            'Natural-language request. Examples: "calendar today", "flights this week", "create meeting tomorrow 3pm".',
                        },
                        title: {
                          type: "string",
                          description:
                            "title TOP-LEVEL; NOT details. create_event needs title + details.start/end",
                        },
                        query: {
                          type: "string",
                          description:
                            "Search phrase for search_events/travel_itinerary: flight, dentist, Denver.",
                        },
                        queries: {
                          type: "array",
                          description:
                            "Optional search_events phrases array. Combined/deduped.",
                          items: { type: "string" },
                        },
                        details: {
                          type: "object",
                          description:
                            "details create|update|delete: calendarId,start/end,eventId,location; title/window TOP",
                          required: [],
                          properties: {
                            calendarId: { type: "string" },
                            timeMin: { type: "string" },
                            timeMax: { type: "string" },
                            timeZone: { type: "string" },
                            forceSync: { type: "boolean" },
                            windowDays: { type: "number" },
                            windowPreset: { type: "string" },
                            start: { type: "string" },
                            end: { type: "string" },
                            startAt: { type: "string" },
                            endAt: { type: "string" },
                            durationMinutes: { type: "number" },
                            eventId: { type: "string" },
                            newTitle: { type: "string" },
                            description: { type: "string" },
                            location: { type: "string" },
                            travelOriginAddress: { type: "string" },
                            attendees: {
                              type: "array",
                              items: { type: "string" },
                            },
                          },
                          additionalProperties: false,
                        },
                        durationMinutes: {
                          type: "number",
                          description:
                            "TOP-LEVEL flat. propose_times length minutes. Example: `{ subaction: 'propose_times', durationMinutes: 30, slotCount: 3, windowStart: '...', windowEnd: '...'...",
                        },
                        daysAhead: {
                          type: "number",
                          description:
                            "propose_times days ahead. Default 7. Ignored with windowStart/windowEnd.",
                        },
                        slotCount: {
                          type: "number",
                          description: "propose_times slot count. Default 3.",
                        },
                        windowStart: {
                          type: "string",
                          description:
                            "propose_times window earliest start. ISO-8601.",
                        },
                        windowEnd: {
                          type: "string",
                          description:
                            "propose_times window latest end. ISO-8601.",
                        },
                        startAt: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat. check_availability start. ISO-8601. Example: `{ subaction: 'check_availability', startAt: '2026-05-14T09:00:00Z', endAt...",
                        },
                        endAt: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat. check_availability end. ISO-8601. See `startAt`.",
                        },
                        timeZone: {
                          type: "string",
                          description:
                            "IANA timeZone for update_preferences hours.",
                        },
                        preferredStartLocal: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat for update_preferences. Earliest start local HH:MM 24h. Example: `{ subaction: 'update_preferences', preferredStartLocal: '09:00'...",
                        },
                        preferredEndLocal: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat for update_preferences. Latest end local HH:MM 24h. See `preferredStartLocal`.",
                        },
                        defaultDurationMinutes: {
                          type: "number",
                          description: "Default duration minutes (5-480).",
                        },
                        travelBufferMinutes: {
                          type: "number",
                          description:
                            "Buffer minutes before/after meetings (0-240).",
                        },
                        blackoutWindows: {
                          type: "array",
                          description:
                            "blackoutWindows[]: label startLocal HH:MM endLocal HH:MM daysOfWeek?[0..6]",
                          items: {
                            type: "object",
                            required: ["label", "startLocal", "endLocal"],
                            properties: {
                              label: { type: "string" },
                              startLocal: {
                                type: "string",
                                pattern: "^[0-2][0-9]:[0-5][0-9]$",
                              },
                              endLocal: {
                                type: "string",
                                pattern: "^[0-2][0-9]:[0-5][0-9]$",
                              },
                              daysOfWeek: {
                                type: "array",
                                items: {
                                  type: "number",
                                  minimum: 0,
                                  maximum: 6,
                                },
                              },
                            },
                            additionalProperties: false,
                          },
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  {
                    name: "CALENDAR_BULK_RESCHEDULE",
                    description:
                      "calendar feed|next|search|create|update|delete|trip_window|reschedule|availability|propose",
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: [],
                      properties: {
                        action: {
                          type: "string",
                          description:
                            'Subaction discriminator (auto-set to "bulk_reschedule" for this virtual. do not change).',
                          enum: ["bulk_reschedule"],
                          default: "bulk_reschedule",
                        },
                        intent: {
                          type: "string",
                          description:
                            'Natural-language request. Examples: "calendar today", "flights this week", "create meeting tomorrow 3pm".',
                        },
                        title: {
                          type: "string",
                          description:
                            "title TOP-LEVEL; NOT details. create_event needs title + details.start/end",
                        },
                        query: {
                          type: "string",
                          description:
                            "Search phrase for search_events/travel_itinerary: flight, dentist, Denver.",
                        },
                        queries: {
                          type: "array",
                          description:
                            "Optional search_events phrases array. Combined/deduped.",
                          items: { type: "string" },
                        },
                        details: {
                          type: "object",
                          description:
                            "details create|update|delete: calendarId,start/end,eventId,location; title/window TOP",
                          required: [],
                          properties: {
                            calendarId: { type: "string" },
                            timeMin: { type: "string" },
                            timeMax: { type: "string" },
                            timeZone: { type: "string" },
                            forceSync: { type: "boolean" },
                            windowDays: { type: "number" },
                            windowPreset: { type: "string" },
                            start: { type: "string" },
                            end: { type: "string" },
                            startAt: { type: "string" },
                            endAt: { type: "string" },
                            durationMinutes: { type: "number" },
                            eventId: { type: "string" },
                            newTitle: { type: "string" },
                            description: { type: "string" },
                            location: { type: "string" },
                            travelOriginAddress: { type: "string" },
                            attendees: {
                              type: "array",
                              items: { type: "string" },
                            },
                          },
                          additionalProperties: false,
                        },
                        durationMinutes: {
                          type: "number",
                          description:
                            "TOP-LEVEL flat. propose_times length minutes. Example: `{ subaction: 'propose_times', durationMinutes: 30, slotCount: 3, windowStart: '...', windowEnd: '...'...",
                        },
                        daysAhead: {
                          type: "number",
                          description:
                            "propose_times days ahead. Default 7. Ignored with windowStart/windowEnd.",
                        },
                        slotCount: {
                          type: "number",
                          description: "propose_times slot count. Default 3.",
                        },
                        windowStart: {
                          type: "string",
                          description:
                            "propose_times window earliest start. ISO-8601.",
                        },
                        windowEnd: {
                          type: "string",
                          description:
                            "propose_times window latest end. ISO-8601.",
                        },
                        startAt: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat. check_availability start. ISO-8601. Example: `{ subaction: 'check_availability', startAt: '2026-05-14T09:00:00Z', endAt...",
                        },
                        endAt: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat. check_availability end. ISO-8601. See `startAt`.",
                        },
                        timeZone: {
                          type: "string",
                          description:
                            "IANA timeZone for update_preferences hours.",
                        },
                        preferredStartLocal: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat for update_preferences. Earliest start local HH:MM 24h. Example: `{ subaction: 'update_preferences', preferredStartLocal: '09:00'...",
                        },
                        preferredEndLocal: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat for update_preferences. Latest end local HH:MM 24h. See `preferredStartLocal`.",
                        },
                        defaultDurationMinutes: {
                          type: "number",
                          description: "Default duration minutes (5-480).",
                        },
                        travelBufferMinutes: {
                          type: "number",
                          description:
                            "Buffer minutes before/after meetings (0-240).",
                        },
                        blackoutWindows: {
                          type: "array",
                          description:
                            "blackoutWindows[]: label startLocal HH:MM endLocal HH:MM daysOfWeek?[0..6]",
                          items: {
                            type: "object",
                            required: ["label", "startLocal", "endLocal"],
                            properties: {
                              label: { type: "string" },
                              startLocal: {
                                type: "string",
                                pattern: "^[0-2][0-9]:[0-5][0-9]$",
                              },
                              endLocal: {
                                type: "string",
                                pattern: "^[0-2][0-9]:[0-5][0-9]$",
                              },
                              daysOfWeek: {
                                type: "array",
                                items: {
                                  type: "number",
                                  minimum: 0,
                                  maximum: 6,
                                },
                              },
                            },
                            additionalProperties: false,
                          },
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  {
                    name: "CALENDAR_CHECK_AVAILABILITY",
                    description:
                      "calendar feed|next|search|create|update|delete|trip_window|reschedule|availability|propose",
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: [],
                      properties: {
                        action: {
                          type: "string",
                          description:
                            'Subaction discriminator (auto-set to "check_availability" for this virtual. do not change).',
                          enum: ["check_availability"],
                          default: "check_availability",
                        },
                        intent: {
                          type: "string",
                          description:
                            'Natural-language request. Examples: "calendar today", "flights this week", "create meeting tomorrow 3pm".',
                        },
                        title: {
                          type: "string",
                          description:
                            "title TOP-LEVEL; NOT details. create_event needs title + details.start/end",
                        },
                        query: {
                          type: "string",
                          description:
                            "Search phrase for search_events/travel_itinerary: flight, dentist, Denver.",
                        },
                        queries: {
                          type: "array",
                          description:
                            "Optional search_events phrases array. Combined/deduped.",
                          items: { type: "string" },
                        },
                        details: {
                          type: "object",
                          description:
                            "details create|update|delete: calendarId,start/end,eventId,location; title/window TOP",
                          required: [],
                          properties: {
                            calendarId: { type: "string" },
                            timeMin: { type: "string" },
                            timeMax: { type: "string" },
                            timeZone: { type: "string" },
                            forceSync: { type: "boolean" },
                            windowDays: { type: "number" },
                            windowPreset: { type: "string" },
                            start: { type: "string" },
                            end: { type: "string" },
                            startAt: { type: "string" },
                            endAt: { type: "string" },
                            durationMinutes: { type: "number" },
                            eventId: { type: "string" },
                            newTitle: { type: "string" },
                            description: { type: "string" },
                            location: { type: "string" },
                            travelOriginAddress: { type: "string" },
                            attendees: {
                              type: "array",
                              items: { type: "string" },
                            },
                          },
                          additionalProperties: false,
                        },
                        durationMinutes: {
                          type: "number",
                          description:
                            "TOP-LEVEL flat. propose_times length minutes. Example: `{ subaction: 'propose_times', durationMinutes: 30, slotCount: 3, windowStart: '...', windowEnd: '...'...",
                        },
                        daysAhead: {
                          type: "number",
                          description:
                            "propose_times days ahead. Default 7. Ignored with windowStart/windowEnd.",
                        },
                        slotCount: {
                          type: "number",
                          description: "propose_times slot count. Default 3.",
                        },
                        windowStart: {
                          type: "string",
                          description:
                            "propose_times window earliest start. ISO-8601.",
                        },
                        windowEnd: {
                          type: "string",
                          description:
                            "propose_times window latest end. ISO-8601.",
                        },
                        startAt: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat. check_availability start. ISO-8601. Example: `{ subaction: 'check_availability', startAt: '2026-05-14T09:00:00Z', endAt...",
                        },
                        endAt: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat. check_availability end. ISO-8601. See `startAt`.",
                        },
                        timeZone: {
                          type: "string",
                          description:
                            "IANA timeZone for update_preferences hours.",
                        },
                        preferredStartLocal: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat for update_preferences. Earliest start local HH:MM 24h. Example: `{ subaction: 'update_preferences', preferredStartLocal: '09:00'...",
                        },
                        preferredEndLocal: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat for update_preferences. Latest end local HH:MM 24h. See `preferredStartLocal`.",
                        },
                        defaultDurationMinutes: {
                          type: "number",
                          description: "Default duration minutes (5-480).",
                        },
                        travelBufferMinutes: {
                          type: "number",
                          description:
                            "Buffer minutes before/after meetings (0-240).",
                        },
                        blackoutWindows: {
                          type: "array",
                          description:
                            "blackoutWindows[]: label startLocal HH:MM endLocal HH:MM daysOfWeek?[0..6]",
                          items: {
                            type: "object",
                            required: ["label", "startLocal", "endLocal"],
                            properties: {
                              label: { type: "string" },
                              startLocal: {
                                type: "string",
                                pattern: "^[0-2][0-9]:[0-5][0-9]$",
                              },
                              endLocal: {
                                type: "string",
                                pattern: "^[0-2][0-9]:[0-5][0-9]$",
                              },
                              daysOfWeek: {
                                type: "array",
                                items: {
                                  type: "number",
                                  minimum: 0,
                                  maximum: 6,
                                },
                              },
                            },
                            additionalProperties: false,
                          },
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  {
                    name: "CALENDAR_PROPOSE_TIMES",
                    description:
                      "calendar feed|next|search|create|update|delete|trip_window|reschedule|availability|propose",
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: [],
                      properties: {
                        action: {
                          type: "string",
                          description:
                            'Subaction discriminator (auto-set to "propose_times" for this virtual. do not change).',
                          enum: ["propose_times"],
                          default: "propose_times",
                        },
                        intent: {
                          type: "string",
                          description:
                            'Natural-language request. Examples: "calendar today", "flights this week", "create meeting tomorrow 3pm".',
                        },
                        title: {
                          type: "string",
                          description:
                            "title TOP-LEVEL; NOT details. create_event needs title + details.start/end",
                        },
                        query: {
                          type: "string",
                          description:
                            "Search phrase for search_events/travel_itinerary: flight, dentist, Denver.",
                        },
                        queries: {
                          type: "array",
                          description:
                            "Optional search_events phrases array. Combined/deduped.",
                          items: { type: "string" },
                        },
                        details: {
                          type: "object",
                          description:
                            "details create|update|delete: calendarId,start/end,eventId,location; title/window TOP",
                          required: [],
                          properties: {
                            calendarId: { type: "string" },
                            timeMin: { type: "string" },
                            timeMax: { type: "string" },
                            timeZone: { type: "string" },
                            forceSync: { type: "boolean" },
                            windowDays: { type: "number" },
                            windowPreset: { type: "string" },
                            start: { type: "string" },
                            end: { type: "string" },
                            startAt: { type: "string" },
                            endAt: { type: "string" },
                            durationMinutes: { type: "number" },
                            eventId: { type: "string" },
                            newTitle: { type: "string" },
                            description: { type: "string" },
                            location: { type: "string" },
                            travelOriginAddress: { type: "string" },
                            attendees: {
                              type: "array",
                              items: { type: "string" },
                            },
                          },
                          additionalProperties: false,
                        },
                        durationMinutes: {
                          type: "number",
                          description:
                            "TOP-LEVEL flat. propose_times length minutes. Example: `{ subaction: 'propose_times', durationMinutes: 30, slotCount: 3, windowStart: '...', windowEnd: '...'...",
                        },
                        daysAhead: {
                          type: "number",
                          description:
                            "propose_times days ahead. Default 7. Ignored with windowStart/windowEnd.",
                        },
                        slotCount: {
                          type: "number",
                          description: "propose_times slot count. Default 3.",
                        },
                        windowStart: {
                          type: "string",
                          description:
                            "propose_times window earliest start. ISO-8601.",
                        },
                        windowEnd: {
                          type: "string",
                          description:
                            "propose_times window latest end. ISO-8601.",
                        },
                        startAt: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat. check_availability start. ISO-8601. Example: `{ subaction: 'check_availability', startAt: '2026-05-14T09:00:00Z', endAt...",
                        },
                        endAt: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat. check_availability end. ISO-8601. See `startAt`.",
                        },
                        timeZone: {
                          type: "string",
                          description:
                            "IANA timeZone for update_preferences hours.",
                        },
                        preferredStartLocal: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat for update_preferences. Earliest start local HH:MM 24h. Example: `{ subaction: 'update_preferences', preferredStartLocal: '09:00'...",
                        },
                        preferredEndLocal: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat for update_preferences. Latest end local HH:MM 24h. See `preferredStartLocal`.",
                        },
                        defaultDurationMinutes: {
                          type: "number",
                          description: "Default duration minutes (5-480).",
                        },
                        travelBufferMinutes: {
                          type: "number",
                          description:
                            "Buffer minutes before/after meetings (0-240).",
                        },
                        blackoutWindows: {
                          type: "array",
                          description:
                            "blackoutWindows[]: label startLocal HH:MM endLocal HH:MM daysOfWeek?[0..6]",
                          items: {
                            type: "object",
                            required: ["label", "startLocal", "endLocal"],
                            properties: {
                              label: { type: "string" },
                              startLocal: {
                                type: "string",
                                pattern: "^[0-2][0-9]:[0-5][0-9]$",
                              },
                              endLocal: {
                                type: "string",
                                pattern: "^[0-2][0-9]:[0-5][0-9]$",
                              },
                              daysOfWeek: {
                                type: "array",
                                items: {
                                  type: "number",
                                  minimum: 0,
                                  maximum: 6,
                                },
                              },
                            },
                            additionalProperties: false,
                          },
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  {
                    name: "CALENDAR_UPDATE_PREFERENCES",
                    description:
                      "calendar feed|next|search|create|update|delete|trip_window|reschedule|availability|propose",
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: [],
                      properties: {
                        action: {
                          type: "string",
                          description:
                            'Subaction discriminator (auto-set to "update_preferences" for this virtual. do not change).',
                          enum: ["update_preferences"],
                          default: "update_preferences",
                        },
                        intent: {
                          type: "string",
                          description:
                            'Natural-language request. Examples: "calendar today", "flights this week", "create meeting tomorrow 3pm".',
                        },
                        title: {
                          type: "string",
                          description:
                            "title TOP-LEVEL; NOT details. create_event needs title + details.start/end",
                        },
                        query: {
                          type: "string",
                          description:
                            "Search phrase for search_events/travel_itinerary: flight, dentist, Denver.",
                        },
                        queries: {
                          type: "array",
                          description:
                            "Optional search_events phrases array. Combined/deduped.",
                          items: { type: "string" },
                        },
                        details: {
                          type: "object",
                          description:
                            "details create|update|delete: calendarId,start/end,eventId,location; title/window TOP",
                          required: [],
                          properties: {
                            calendarId: { type: "string" },
                            timeMin: { type: "string" },
                            timeMax: { type: "string" },
                            timeZone: { type: "string" },
                            forceSync: { type: "boolean" },
                            windowDays: { type: "number" },
                            windowPreset: { type: "string" },
                            start: { type: "string" },
                            end: { type: "string" },
                            startAt: { type: "string" },
                            endAt: { type: "string" },
                            durationMinutes: { type: "number" },
                            eventId: { type: "string" },
                            newTitle: { type: "string" },
                            description: { type: "string" },
                            location: { type: "string" },
                            travelOriginAddress: { type: "string" },
                            attendees: {
                              type: "array",
                              items: { type: "string" },
                            },
                          },
                          additionalProperties: false,
                        },
                        durationMinutes: {
                          type: "number",
                          description:
                            "TOP-LEVEL flat. propose_times length minutes. Example: `{ subaction: 'propose_times', durationMinutes: 30, slotCount: 3, windowStart: '...', windowEnd: '...'...",
                        },
                        daysAhead: {
                          type: "number",
                          description:
                            "propose_times days ahead. Default 7. Ignored with windowStart/windowEnd.",
                        },
                        slotCount: {
                          type: "number",
                          description: "propose_times slot count. Default 3.",
                        },
                        windowStart: {
                          type: "string",
                          description:
                            "propose_times window earliest start. ISO-8601.",
                        },
                        windowEnd: {
                          type: "string",
                          description:
                            "propose_times window latest end. ISO-8601.",
                        },
                        startAt: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat. check_availability start. ISO-8601. Example: `{ subaction: 'check_availability', startAt: '2026-05-14T09:00:00Z', endAt...",
                        },
                        endAt: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat. check_availability end. ISO-8601. See `startAt`.",
                        },
                        timeZone: {
                          type: "string",
                          description:
                            "IANA timeZone for update_preferences hours.",
                        },
                        preferredStartLocal: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat for update_preferences. Earliest start local HH:MM 24h. Example: `{ subaction: 'update_preferences', preferredStartLocal: '09:00'...",
                        },
                        preferredEndLocal: {
                          type: "string",
                          description:
                            "TOP-LEVEL flat for update_preferences. Latest end local HH:MM 24h. See `preferredStartLocal`.",
                        },
                        defaultDurationMinutes: {
                          type: "number",
                          description: "Default duration minutes (5-480).",
                        },
                        travelBufferMinutes: {
                          type: "number",
                          description:
                            "Buffer minutes before/after meetings (0-240).",
                        },
                        blackoutWindows: {
                          type: "array",
                          description:
                            "blackoutWindows[]: label startLocal HH:MM endLocal HH:MM daysOfWeek?[0..6]",
                          items: {
                            type: "object",
                            required: ["label", "startLocal", "endLocal"],
                            properties: {
                              label: { type: "string" },
                              startLocal: {
                                type: "string",
                                pattern: "^[0-2][0-9]:[0-5][0-9]$",
                              },
                              endLocal: {
                                type: "string",
                                pattern: "^[0-2][0-9]:[0-5][0-9]$",
                              },
                              daysOfWeek: {
                                type: "array",
                                items: {
                                  type: "number",
                                  minimum: 0,
                                  maximum: 6,
                                },
                              },
                            },
                            additionalProperties: false,
                          },
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  {
                    name: "RESOLVE_REQUEST",
                    description:
                      "approve|reject queue; requestId optional; send_email|send_message|book_travel|voice_call",
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: [],
                      properties: {
                        action: {
                          type: "string",
                          description: "approve | reject.",
                          enum: ["approve", "reject"],
                        },
                        requestId: {
                          type: "string",
                          description:
                            "Approval request id. Optional when user references pending request.",
                        },
                        reason: {
                          type: "string",
                          description:
                            "Optional approve/reject reason, user language.",
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  {
                    name: "RESOLVE_REQUEST_APPROVE",
                    description:
                      "approve|reject queue; requestId optional; send_email|send_message|book_travel|voice_call",
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: [],
                      properties: {
                        action: {
                          type: "string",
                          description:
                            'Subaction discriminator (auto-set to "approve" for this virtual. do not change).',
                          enum: ["approve"],
                          default: "approve",
                        },
                        requestId: {
                          type: "string",
                          description:
                            "Approval request id. Optional when user references pending request.",
                        },
                        reason: {
                          type: "string",
                          description:
                            "Optional approve/reject reason, user language.",
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  {
                    name: "RESOLVE_REQUEST_REJECT",
                    description:
                      "approve|reject queue; requestId optional; send_email|send_message|book_travel|voice_call",
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: [],
                      properties: {
                        action: {
                          type: "string",
                          description:
                            'Subaction discriminator (auto-set to "reject" for this virtual. do not change).',
                          enum: ["reject"],
                          default: "reject",
                        },
                        requestId: {
                          type: "string",
                          description:
                            "Approval request id. Optional when user references pending request.",
                        },
                        reason: {
                          type: "string",
                          description:
                            "Optional approve/reject reason, user language.",
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  {
                    name: "OWNER_ALARMS",
                    description:
                      "owner alarms: action=create|update|delete|complete|skip|snooze|review -> OWNER_ALARMS; owner-only LifeOps\nowner alarms: action=create|update|delete|complete|skip|snooze|review",
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: [],
                      properties: {
                        action: {
                          type: "string",
                          description:
                            "Owner item op: create|update|delete|complete|skip|snooze|review.",
                          enum: [
                            "create",
                            "update",
                            "delete",
                            "complete",
                            "skip",
                            "snooze",
                            "review",
                          ],
                        },
                        kind: {
                          type: "string",
                          description: "Optional backing kind override.",
                          enum: ["definition", "goal"],
                        },
                        intent: {
                          type: "string",
                          description: "Free-form owner request.",
                        },
                        title: {
                          type: "string",
                          description: "Item title when known.",
                        },
                        target: {
                          type: "string",
                          description:
                            "Existing item id/title for update/delete/complete/skip/snooze/review.",
                        },
                        minutes: {
                          type: "number",
                          description: "Snooze minutes when action=snooze.",
                        },
                        details: {
                          type: "object",
                          description:
                            "Structured schedule/cadence/notes/details.",
                          required: [],
                          properties: {},
                          additionalProperties: true,
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  {
                    name: "OWNER_HEALTH_TODAY",
                    description:
                      'owner health/wearable reads ("step count", "sleep last night", heart rate, workouts) -> OWNER_HEALTH\nowner health: today|trend|by_metric|status; read-only telemetry',
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: [],
                      properties: {
                        action: {
                          type: "string",
                          description:
                            'Subaction discriminator (auto-set to "today" for this virtual. do not change).',
                          enum: ["today"],
                          default: "today",
                        },
                        intent: {
                          type: "string",
                          description: "free-form intent infer subaction",
                        },
                        metric: {
                          type: "string",
                          description:
                            "by_metric: steps|heart_rate|sleep_hours|calories|distance_meters|active_minutes (e.g. steps, sleep_hours, heart_rate)",
                          enum: [
                            "steps",
                            "heart_rate",
                            "sleep_hours",
                            "calories",
                            "distance_meters",
                            "active_minutes",
                          ],
                        },
                        date: {
                          type: "string",
                          description:
                            "YYYY-MM-DD single-day (e.g. 2026-05-10)",
                        },
                        days: {
                          type: "number",
                          description:
                            "window days trend|by_metric (e.g. 1, 7, 30)",
                          minimum: 1,
                          maximum: 365,
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  {
                    name: "OWNER_HEALTH_BY_METRIC",
                    description:
                      'owner health/wearable reads ("step count", "sleep last night", heart rate, workouts) -> OWNER_HEALTH\nowner health: today|trend|by_metric|status; read-only telemetry',
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: [],
                      properties: {
                        action: {
                          type: "string",
                          description:
                            'Subaction discriminator (auto-set to "by_metric" for this virtual. do not change).',
                          enum: ["by_metric"],
                          default: "by_metric",
                        },
                        intent: {
                          type: "string",
                          description: "free-form intent infer subaction",
                        },
                        metric: {
                          type: "string",
                          description:
                            "by_metric: steps|heart_rate|sleep_hours|calories|distance_meters|active_minutes (e.g. steps, sleep_hours, heart_rate)",
                          enum: [
                            "steps",
                            "heart_rate",
                            "sleep_hours",
                            "calories",
                            "distance_meters",
                            "active_minutes",
                          ],
                        },
                        date: {
                          type: "string",
                          description:
                            "YYYY-MM-DD single-day (e.g. 2026-05-10)",
                        },
                        days: {
                          type: "number",
                          description:
                            "window days trend|by_metric (e.g. 1, 7, 30)",
                          minimum: 1,
                          maximum: 365,
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  {
                    name: "OWNER_HEALTH_STATUS",
                    description:
                      'owner health/wearable reads ("step count", "sleep last night", heart rate, workouts) -> OWNER_HEALTH\nowner health: today|trend|by_metric|status; read-only telemetry',
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: [],
                      properties: {
                        action: {
                          type: "string",
                          description:
                            'Subaction discriminator (auto-set to "status" for this virtual. do not change).',
                          enum: ["status"],
                          default: "status",
                        },
                        intent: {
                          type: "string",
                          description: "free-form intent infer subaction",
                        },
                        metric: {
                          type: "string",
                          description:
                            "by_metric: steps|heart_rate|sleep_hours|calories|distance_meters|active_minutes (e.g. steps, sleep_hours, heart_rate)",
                          enum: [
                            "steps",
                            "heart_rate",
                            "sleep_hours",
                            "calories",
                            "distance_meters",
                            "active_minutes",
                          ],
                        },
                        date: {
                          type: "string",
                          description:
                            "YYYY-MM-DD single-day (e.g. 2026-05-10)",
                        },
                        days: {
                          type: "number",
                          description:
                            "window days trend|by_metric (e.g. 1, 7, 30)",
                          minimum: 1,
                          maximum: 365,
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  {
                    name: "OWNER_SCREENTIME_SUMMARY",
                    description:
                      "owner screentime summary|today|weekly|by_app|by_website|activity|time_on_app|time_on_site",
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: [],
                      properties: {
                        action: {
                          type: "string",
                          description:
                            'Subaction discriminator (auto-set to "summary" for this virtual. do not change).',
                          enum: ["summary"],
                          default: "summary",
                        },
                        source: {
                          type: "string",
                          description: "source filter: app|website",
                          enum: ["app", "website"],
                        },
                        identifier: {
                          type: "string",
                          description:
                            "Specific app bundle id or website domain when filtering screen-time to one source.",
                        },
                        date: {
                          type: "string",
                          description: "YYYY-MM-DD for the today subaction.",
                        },
                        days: {
                          type: "number",
                          description:
                            "Number of days back from now for weekly/weekly_average_by_app windows.",
                        },
                        limit: {
                          type: "number",
                          description:
                            "Top-N for by_app/by_website/browser_activity (default 10).",
                        },
                        windowDays: {
                          type: "number",
                          description:
                            "Window in days for by_app/by_website summary queries.",
                        },
                        windowHours: {
                          type: "number",
                          description:
                            "Window in hours for activity_report/time_on_app/time_on_site (default 24, max 720).",
                        },
                        appNameOrBundleId: {
                          type: "string",
                          description:
                            "App name (e. g. 'Safari') or bundle id (e. g. 'com. apple. Safari') for time_on_app.",
                        },
                        domain: {
                          type: "string",
                          description:
                            "Hostname (e. g. 'github. com') for time_on_site.",
                        },
                        deviceId: {
                          type: "string",
                          description:
                            "Filter browser_activity to one registered device id. omit for default.",
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  {
                    name: "OWNER_SCREENTIME_TODAY",
                    description:
                      "owner screentime summary|today|weekly|by_app|by_website|activity|time_on_app|time_on_site",
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: [],
                      properties: {
                        action: {
                          type: "string",
                          description:
                            'Subaction discriminator (auto-set to "today" for this virtual. do not change).',
                          enum: ["today"],
                          default: "today",
                        },
                        source: {
                          type: "string",
                          description: "source filter: app|website",
                          enum: ["app", "website"],
                        },
                        identifier: {
                          type: "string",
                          description:
                            "Specific app bundle id or website domain when filtering screen-time to one source.",
                        },
                        date: {
                          type: "string",
                          description: "YYYY-MM-DD for the today subaction.",
                        },
                        days: {
                          type: "number",
                          description:
                            "Number of days back from now for weekly/weekly_average_by_app windows.",
                        },
                        limit: {
                          type: "number",
                          description:
                            "Top-N for by_app/by_website/browser_activity (default 10).",
                        },
                        windowDays: {
                          type: "number",
                          description:
                            "Window in days for by_app/by_website summary queries.",
                        },
                        windowHours: {
                          type: "number",
                          description:
                            "Window in hours for activity_report/time_on_app/time_on_site (default 24, max 720).",
                        },
                        appNameOrBundleId: {
                          type: "string",
                          description:
                            "App name (e. g. 'Safari') or bundle id (e. g. 'com. apple. Safari') for time_on_app.",
                        },
                        domain: {
                          type: "string",
                          description:
                            "Hostname (e. g. 'github. com') for time_on_site.",
                        },
                        deviceId: {
                          type: "string",
                          description:
                            "Filter browser_activity to one registered device id. omit for default.",
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  {
                    name: "OWNER_SCREENTIME_WEEKLY",
                    description:
                      "owner screentime summary|today|weekly|by_app|by_website|activity|time_on_app|time_on_site",
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: [],
                      properties: {
                        action: {
                          type: "string",
                          description:
                            'Subaction discriminator (auto-set to "weekly" for this virtual. do not change).',
                          enum: ["weekly"],
                          default: "weekly",
                        },
                        source: {
                          type: "string",
                          description: "source filter: app|website",
                          enum: ["app", "website"],
                        },
                        identifier: {
                          type: "string",
                          description:
                            "Specific app bundle id or website domain when filtering screen-time to one source.",
                        },
                        date: {
                          type: "string",
                          description: "YYYY-MM-DD for the today subaction.",
                        },
                        days: {
                          type: "number",
                          description:
                            "Number of days back from now for weekly/weekly_average_by_app windows.",
                        },
                        limit: {
                          type: "number",
                          description:
                            "Top-N for by_app/by_website/browser_activity (default 10).",
                        },
                        windowDays: {
                          type: "number",
                          description:
                            "Window in days for by_app/by_website summary queries.",
                        },
                        windowHours: {
                          type: "number",
                          description:
                            "Window in hours for activity_report/time_on_app/time_on_site (default 24, max 720).",
                        },
                        appNameOrBundleId: {
                          type: "string",
                          description:
                            "App name (e. g. 'Safari') or bundle id (e. g. 'com. apple. Safari') for time_on_app.",
                        },
                        domain: {
                          type: "string",
                          description:
                            "Hostname (e. g. 'github. com') for time_on_site.",
                        },
                        deviceId: {
                          type: "string",
                          description:
                            "Filter browser_activity to one registered device id. omit for default.",
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  {
                    name: "OWNER_SCREENTIME_BY_APP",
                    description:
                      "owner screentime summary|today|weekly|by_app|by_website|activity|time_on_app|time_on_site",
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: [],
                      properties: {
                        action: {
                          type: "string",
                          description:
                            'Subaction discriminator (auto-set to "by_app" for this virtual. do not change).',
                          enum: ["by_app"],
                          default: "by_app",
                        },
                        source: {
                          type: "string",
                          description: "source filter: app|website",
                          enum: ["app", "website"],
                        },
                        identifier: {
                          type: "string",
                          description:
                            "Specific app bundle id or website domain when filtering screen-time to one source.",
                        },
                        date: {
                          type: "string",
                          description: "YYYY-MM-DD for the today subaction.",
                        },
                        days: {
                          type: "number",
                          description:
                            "Number of days back from now for weekly/weekly_average_by_app windows.",
                        },
                        limit: {
                          type: "number",
                          description:
                            "Top-N for by_app/by_website/browser_activity (default 10).",
                        },
                        windowDays: {
                          type: "number",
                          description:
                            "Window in days for by_app/by_website summary queries.",
                        },
                        windowHours: {
                          type: "number",
                          description:
                            "Window in hours for activity_report/time_on_app/time_on_site (default 24, max 720).",
                        },
                        appNameOrBundleId: {
                          type: "string",
                          description:
                            "App name (e. g. 'Safari') or bundle id (e. g. 'com. apple. Safari') for time_on_app.",
                        },
                        domain: {
                          type: "string",
                          description:
                            "Hostname (e. g. 'github. com') for time_on_site.",
                        },
                        deviceId: {
                          type: "string",
                          description:
                            "Filter browser_activity to one registered device id. omit for default.",
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  {
                    name: "OWNER_SCREENTIME_BY_WEBSITE",
                    description:
                      "owner screentime summary|today|weekly|by_app|by_website|activity|time_on_app|time_on_site",
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: [],
                      properties: {
                        action: {
                          type: "string",
                          description:
                            'Subaction discriminator (auto-set to "by_website" for this virtual. do not change).',
                          enum: ["by_website"],
                          default: "by_website",
                        },
                        source: {
                          type: "string",
                          description: "source filter: app|website",
                          enum: ["app", "website"],
                        },
                        identifier: {
                          type: "string",
                          description:
                            "Specific app bundle id or website domain when filtering screen-time to one source.",
                        },
                        date: {
                          type: "string",
                          description: "YYYY-MM-DD for the today subaction.",
                        },
                        days: {
                          type: "number",
                          description:
                            "Number of days back from now for weekly/weekly_average_by_app windows.",
                        },
                        limit: {
                          type: "number",
                          description:
                            "Top-N for by_app/by_website/browser_activity (default 10).",
                        },
                        windowDays: {
                          type: "number",
                          description:
                            "Window in days for by_app/by_website summary queries.",
                        },
                        windowHours: {
                          type: "number",
                          description:
                            "Window in hours for activity_report/time_on_app/time_on_site (default 24, max 720).",
                        },
                        appNameOrBundleId: {
                          type: "string",
                          description:
                            "App name (e. g. 'Safari') or bundle id (e. g. 'com. apple. Safari') for time_on_app.",
                        },
                        domain: {
                          type: "string",
                          description:
                            "Hostname (e. g. 'github. com') for time_on_site.",
                        },
                        deviceId: {
                          type: "string",
                          description:
                            "Filter browser_activity to one registered device id. omit for default.",
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  {
                    name: "OWNER_SCREENTIME_ACTIVITY_REPORT",
                    description:
                      "owner screentime summary|today|weekly|by_app|by_website|activity|time_on_app|time_on_site",
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: [],
                      properties: {
                        action: {
                          type: "string",
                          description:
                            'Subaction discriminator (auto-set to "activity_report" for this virtual. do not change).',
                          enum: ["activity_report"],
                          default: "activity_report",
                        },
                        source: {
                          type: "string",
                          description: "source filter: app|website",
                          enum: ["app", "website"],
                        },
                        identifier: {
                          type: "string",
                          description:
                            "Specific app bundle id or website domain when filtering screen-time to one source.",
                        },
                        date: {
                          type: "string",
                          description: "YYYY-MM-DD for the today subaction.",
                        },
                        days: {
                          type: "number",
                          description:
                            "Number of days back from now for weekly/weekly_average_by_app windows.",
                        },
                        limit: {
                          type: "number",
                          description:
                            "Top-N for by_app/by_website/browser_activity (default 10).",
                        },
                        windowDays: {
                          type: "number",
                          description:
                            "Window in days for by_app/by_website summary queries.",
                        },
                        windowHours: {
                          type: "number",
                          description:
                            "Window in hours for activity_report/time_on_app/time_on_site (default 24, max 720).",
                        },
                        appNameOrBundleId: {
                          type: "string",
                          description:
                            "App name (e. g. 'Safari') or bundle id (e. g. 'com. apple. Safari') for time_on_app.",
                        },
                        domain: {
                          type: "string",
                          description:
                            "Hostname (e. g. 'github. com') for time_on_site.",
                        },
                        deviceId: {
                          type: "string",
                          description:
                            "Filter browser_activity to one registered device id. omit for default.",
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  {
                    name: "OWNER_SCREENTIME_BROWSER_ACTIVITY",
                    description:
                      "owner screentime summary|today|weekly|by_app|by_website|activity|time_on_app|time_on_site",
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: [],
                      properties: {
                        action: {
                          type: "string",
                          description:
                            'Subaction discriminator (auto-set to "browser_activity" for this virtual. do not change).',
                          enum: ["browser_activity"],
                          default: "browser_activity",
                        },
                        source: {
                          type: "string",
                          description: "source filter: app|website",
                          enum: ["app", "website"],
                        },
                        identifier: {
                          type: "string",
                          description:
                            "Specific app bundle id or website domain when filtering screen-time to one source.",
                        },
                        date: {
                          type: "string",
                          description: "YYYY-MM-DD for the today subaction.",
                        },
                        days: {
                          type: "number",
                          description:
                            "Number of days back from now for weekly/weekly_average_by_app windows.",
                        },
                        limit: {
                          type: "number",
                          description:
                            "Top-N for by_app/by_website/browser_activity (default 10).",
                        },
                        windowDays: {
                          type: "number",
                          description:
                            "Window in days for by_app/by_website summary queries.",
                        },
                        windowHours: {
                          type: "number",
                          description:
                            "Window in hours for activity_report/time_on_app/time_on_site (default 24, max 720).",
                        },
                        appNameOrBundleId: {
                          type: "string",
                          description:
                            "App name (e. g. 'Safari') or bundle id (e. g. 'com. apple. Safari') for time_on_app.",
                        },
                        domain: {
                          type: "string",
                          description:
                            "Hostname (e. g. 'github. com') for time_on_site.",
                        },
                        deviceId: {
                          type: "string",
                          description:
                            "Filter browser_activity to one registered device id. omit for default.",
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  {
                    name: "REPLY",
                    description:
                      "reply to the user with text; terminates the turn",
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: [],
                      properties: {
                        text: {
                          type: "string",
                          description: "The user-facing reply text.",
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  {
                    name: "IGNORE",
                    description: "terminate the turn silently; emit no reply",
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: [],
                      properties: {},
                      additionalProperties: false,
                    },
                  },
                  {
                    name: "STOP",
                    description: "stop the turn with a terminal stop signal",
                    type: "function",
                    strict: true,
                    parameters: {
                      type: "object",
                      required: [],
                      properties: {},
                      additionalProperties: false,
                    },
                  },
                ],
                toolChoice: "required",
                providerOptions: {
                  eliza: {
                    promptCacheKey:
                      "v5:e2e7887ce94ac9ea5c3b655dc0277a7bf71be3bcde0c0a3475f6e49c87e33fd6",
                    prefixHash:
                      "e2e7887ce94ac9ea5c3b655dc0277a7bf71be3bcde0c0a3475f6e49c87e33fd6",
                    segmentHashes: [
                      "ab8cf1343ace051ce69c596cc87708fd3426291ebcbcd4039f0994601b7d3612",
                      "70d7d443951dd9c6ccfeb1cca3d1e2330f54ae693f4439069bb1f625fbb45c18",
                      "850b4e10742c64b6d83be119a7da6f24f0d13b5a28dfec6188abcbf8e44ddf35",
                      "29f6bddfaa8e7a543be8b60f577e1e97a3cf72e718261dda93940a3c0510c66c",
                      "0d89bd99f9cc76fba69bf8ea9eb426ba207a7a03eecbd1ddea8894dffb480948",
                      "512e88459fcbc7e6e73f6bd9d25711273ab983fba796ef0cb1cbc89e75f04785",
                      "8c53e8428f25f5ccc23d314108d913ea9262e5b9b7ac69d885dead0c6bfd0ef0",
                      "eeda671967c7cf431f8dadcd31196c97a0c94db1b024d02fde63e9045abc030a",
                      "a4a3da64b798cd6fe913b6d2d4df8511586a11229698b7fa25a5c273e4739547",
                      "77fafa9d8490011762b2efa49f96d0958bbfbc41849d9ffdfa7f69c78a838892",
                      "7860c3dedaf4d098a19b41075ab83435c9fcd6ea1ec64728a585660a0b397bdd",
                      "fb0e3cf357f52eed7c29249aada0465a4ee72b30875b8c30bb147d266ca044f1",
                      "cd32700428001eaefd419bb21332eccba9ae7fdb7a4728bce8c7363f676c1d70",
                      "1f84135839fc4d7831a7a3ffa8bf6d86b3646685f4c5698ba24d023fabcf2b8f",
                      "2b7ec29c6e1d333c0b41439db3c58273cef2397d94ce87912456c5a863a7d877",
                      "b7029279b0c09707be870197b54b40b42a734d842976e2b769753dc5dd188474",
                      "49402a30104ff0942ad95a2ec4a827f970fceed11193f78510d66cffd07a9af4",
                    ],
                    cachePlan: {
                      version: 1,
                      anthropicBreakpoints: [
                        {
                          segmentIndex: 2,
                          segmentHash:
                            "850b4e10742c64b6d83be119a7da6f24f0d13b5a28dfec6188abcbf8e44ddf35",
                          ttl: "short",
                          cacheControl: { type: "ephemeral" },
                        },
                        {
                          segmentIndex: 9,
                          segmentHash:
                            "77fafa9d8490011762b2efa49f96d0958bbfbc41849d9ffdfa7f69c78a838892",
                          ttl: "short",
                          cacheControl: { type: "ephemeral" },
                        },
                        {
                          segmentIndex: 16,
                          segmentHash:
                            "49402a30104ff0942ad95a2ec4a827f970fceed11193f78510d66cffd07a9af4",
                          ttl: "short",
                          cacheControl: { type: "ephemeral" },
                        },
                      ],
                    },
                    conversationId: "tj-58d2f3319ed89d",
                    promptSegments: [
                      { content: "user_role: OWNER", stable: true },
                      {
                        content: "\n\nselected_contexts: general",
                        stable: true,
                      },
                      {
                        content:
                          "\n\ncontexts:\n- general: Normal conversation and public agent behavior. Use when the reply needs general agent state but no tool work.",
                        stable: true,
                      },
                      {
                        content: "\n\nNo pending choices for the moment.",
                        stable: false,
                      },
                      {
                        content:
                          "\n\n# Current Time\n- Date: 2026-06-30\n- Time: 07:05:25 UTC\n- Day: Tuesday\n- Full: Tuesday, June 30, 2026 at 7:05:25 AM UTC\n- ISO: 2026-06-30T07:05:25.065Z",
                        stable: false,
                      },
                      {
                        content:
                          '\n\n# People in the Room\n"Backup restore recall" aka "Test User"\nID: 132dfa32-60b3-0e8d-8339-1e6adde36049\n\n"ScenarioAgent"\nID: 546ac3ab-0468-01a2-9d5b-52dfa34bf9cc\n\n"ScenarioUser" aka "Test User"\nID: e7b38d27-3cc3-07d9-b37c-0609c4109734',
                        stable: false,
                      },
                      {
                        content:
                          "\n\nThings ScenarioAgent knows about the speaker:\n[durable.uncategorized conf=0.60] The user's backup recall phrase is exactly: silver comet orchid.",
                        stable: false,
                      },
                      {
                        content: "\n\nNo upcoming follow-ups scheduled.",
                        stable: false,
                      },
                      {
                        content:
                          "\n\n# World Information\n# World: dashboard\nCurrent Channel: Test User (DM)\nTotal Channels: 1\nParticipants in current channel: 3\n\nText channels: 0\nVoice channels: 0\nDM channels: 1\nFeed channels: 0\nThread channels: 0\nOther channels: 0",
                        stable: false,
                      },
                      {
                        content:
                          "\n\nprior_dialogue_policy: Prior chat is context only. For current, latest, live, filesystem, runtime, build, deploy, or verification requests, use the current turn's tools/context instead of answering from prior tool results or stale sub-agent transcripts.",
                        stable: true,
                      },
                      {
                        content:
                          "\n\nPlease remember this backup recall phrase for restore validation: silver comet orchid.",
                        stable: false,
                      },
                      {
                        content:
                          "\n\nBefore this restore, I gave you a backup recall phrase. What exact three-word phrase did I ask you to remember? Reply with only that phrase.",
                        stable: false,
                      },
                      {
                        content:
                          '\n\ncurrent_turn_boundary: The prior_message blocks above are context only. If a reply_reference block follows, it is the platform message that the final message:user is replying to; use it only to resolve references such as this/that/it. Execute and answer only the final message:user below. Do not merge separate prior requests into the current task unless the final message explicitly references them. Exception for visible-context recall: when the final message asks a recall question about what was said in this conversation (who mentioned X, did anyone bring up Y, what did I say about Z, what was the last message), you may scan the prior_message blocks above and answer from what is literally visible there. Before saying you cannot find something, read the final message:user itself: if the asker states a fact and asks about it in the same message ("my favorite color is teal, what is my favorite color?"), answer from the current message directly. Only when the asked-about token appears neither in the current message nor in any visible prior_message block, say so plainly ("I don\'t see X in the recent messages I can see") rather than claiming you searched beyond the visible window or fabricating an action — the prior_message blocks are the only window you have, and there is no separate chat-history search tool.',
                        stable: false,
                      },
                      {
                        content:
                          "\n\nBefore this restore, I gave you a backup recall phrase. What exact three-word phrase did I ask you to remember? Reply with only that phrase.",
                        stable: false,
                      },
                      {
                        content:
                          '\n\nmessage_handler:\nprocessMessage: RESPOND\nplan: {"contexts":["general"],"requiresTool":true,"candidateActions":[],"parentActionHints":[],"reply":"","actionSurface":{"mode":"tiered","candidateActionCount":98,"catalogParentCount":38,"exposedActionCount":37,"tierAParents":["CALENDAR","IGNORE","NONE","OWNER_FINANCES_ADD_SOURCE","OWNER_FINANCES_DASHBOARD","OWNER_FINANCES_IMPORT_CSV","REPLY","RESOLVE_REQUEST"],"tierBParents":["OWNER_ALARMS","OWNER_FINANCES_LIST_SOURCES","OWNER_FINANCES_LIST_TRANSACTIONS","OWNER_FINANCES_RECURRING_CHARGES","OWNER_FINANCES_REMOVE_SOURCE","OWNER_HEALTH_BY_METRIC","OWNER_HEALTH_STATUS","OWNER_HEALTH_TODAY","OWNER_SCREENTIME_ACTIVITY_REPORT","OWNER_SCREENTIME_BROWSER_ACTIVITY","OWNER_SCREENTIME_BY_APP","OWNER_SCREENTIME_BY_WEBSITE","OWNER_SCREENTIME_SUMMARY","OWNER_SCREENTIME_TODAY","OWNER_SCREENTIME_WEEKLY","PERSONALITY"],"omittedParentCount":14,"omittedParentNamesPreview":["OWNER_FINANCES_SPENDING_SUMMARY","OWNER_FINANCES_SUBSCRIPTION_AUDIT","OWNER_FINANCES_SUBSCRIPTION_CANCEL","OWNER_FINANCES_SUBSCRIPTION_STATUS","OWNER_GOALS","OWNER_HEALTH_TREND","OWNER_REMINDERS","OWNER_ROUTINES","OWNER_SCREENTIME_TIME_ON_APP","OWNER_SCREENTIME_TIME_ON_SITE","OWNER_SCREENTIME_WEEKLY_AVERAGE_BY_APP","OWNER_TODOS","PERSONAL_ASSISTANT","SEARCH_CHANNEL_TOPICS"],"actionSurfaceHash":"1g700cd","warnings":0,"queryTokens":["before","this","restore","gave","you","backup","recall","phrase","what","exact","three","word","phrase","did","ask","you","to","remember","reply","with","only","that","phrase"],"candidateActions":[],"parentActionHints":[]}}\nthought: Response handler returned empty output after 3 attempts; falling back to planner because the message is explicitly addressed to the agent.',
                        stable: false,
                      },
                      {
                        content:
                          '\n\n# Routing hints\n- owner alarms: action=create|update|delete|complete|skip|snooze|review -> OWNER_ALARMS; owner-only LifeOps\n- owner health/wearable reads ("step count", "sleep last night", heart rate, workouts) -> OWNER_HEALTH\n- owner health/wearable reads ("step count", "sleep last night", heart rate, workouts) -> OWNER_HEALTH\n- owner health/wearable reads ("step count", "sleep last night", heart rate, workouts) -> OWNER_HEALTH',
                        stable: false,
                      },
                      {
                        content:
                          '\n\nplanner_stage:\ntask: Plan next native tool calls.\n\nrules:\n- use only tools array; smallest grounded queue\n- routed action: set parameters.action only if schema has it\n- args grounded in user request or prior tool results\n- obey schema; arrays as JSON arrays, not comma strings\n- no empty strings/placeholders/invented required args; gather via grounded tool or no tool\n- matching tool exists => call it, even missing details; handler owns questions/drafts/confirm/refusal\n- no messageToUser follow-up when matching tool exists\n- messageToUser is user-visible only; no thoughts, analysis, tool names, function syntax, JSON/tool attempts, "call MESSAGE"\n- more tool work => native toolCalls only; never narrate/simulate calls\n- partial after tool result => next grounded tool, not messageToUser\n- tool-required router decision => run at least one exposed non-terminal tool before terminal answer\n- incomplete while user needs live/current/external data, filesystem/runtime state, command output, repo work, build, PR, deploy, verify, side effect, and exposed tool can try\n- attachments/memory/snippets do not replace explicit current run/check/fetch/inspect/build/deploy/verify/look up now; call tool\n- exposed tool can try => call it; do not say "I cannot browse/search/run/inspect/build/deploy/verify"\n- SHELL is for filesystem/process work, not a fallback for chat-message search/recall, memory queries, or agent-history lookups. When the user wants chat-message search/recall, memory queries, or agent-history lookups and no dedicated search action (e.g. SEARCH_MESSAGES, MESSAGE_SEARCH, MEMORY_SEARCH) is exposed, do not run shell greps, echo placeholders, or simulate the search — set messageToUser explaining that the capability is not available this turn.\n- candidateActions naming a tool that is not in this turn\'s exposed tools list is a dead hint — do not invent SHELL/BROWSER/TASKS workarounds to fulfill it. Either an exposed tool genuinely resolves the user\'s intent (call it), or no tool fits (set messageToUser). Never emit echo-placeholder SHELL commands such as: echo "<intent-name>" / echo "placeholder for <ACTION>" / echo "search <X>" as a way to "trigger" a missing capability — placeholder echoes burn cost and produce no progress.\n- TASKS_SPAWN_AGENT is for delegating coding/build/repo work to a coding sub-agent (file edits, shell tooling, building/deploying apps, running tests, opening PRs). It is not a fallback for chat-message recall, memory queries, or agent-history lookups. Spawning a coding sub-agent to "search the Discord channel for messages mentioning X" routinely ends in sub-agent error/timeout and a generic "Sorry, something went wrong" reply to the user. When the user wants chat-message recall and no dedicated search action is exposed, set messageToUser explaining the capability is not available — do not spawn a sub-agent for it.\n- A one-shot live/current/public-data lookup — current price, weather, score, news headline, a status, or a value at a known URL — is NOT coding work: call WEB_FETCH (construct the single URL yourself) or WEB_SEARCH directly and answer from the result. Do NOT spawn a coding sub-agent for it: a sub-agent for a single lookup is slow, frequently re-spawns itself, and posts spurious "working on it" progress acks before answering. Spawn only when the task is genuinely build/code/repo/multi-step work.\n- no tool fits or task complete => no toolCalls, set messageToUser\n- set completed=false when this turn\'s tool calls do not yet achieve the goal (read-then-act, multi-step deploy/build, verification pending); completed=true only when the goal is achieved this turn. omit when unknown.\n- messageToUser and REPLY text must NEVER claim or imply an investigative OR task-execution action is happening, has happened, or is about to happen — "I\'m fetching X, please hold", "Let me look that up", "Pulling up the info", "Searching for the answer", "I\'m checking now", "I\'ll get back to you", "Spawning a sub-agent", "I\'m working on it", "I\'m fixing that now", "Let me get that done", "Wrapping it up", "Almost done", "Building it now", "I\'ll start on that" — when no tool call this turn is in flight to produce that content. A claim that you are working on / starting / fixing / building / wrapping up a task is only legitimate when a task-executing tool call (e.g. TASKS_SPAWN_AGENT) is actually in flight THIS turn; if you did not spawn a sub-agent or take an action this turn, do not say the task is underway. The planner does not run in the background after returning; once this turn ends, no further tool work happens unless a NEW user message arrives. If your tool iterations exhausted without a usable result (search returned nothing, fetch was blocked, scrape gave no usable HTML, RSS was empty), set messageToUser saying so plainly: "I tried web search via the available tools and couldn\'t find current info on X — try checking a news site directly" or "The searches returned no usable results". Never promise ongoing fetch when this turn is the planner\'s final iteration. This rule covers every grammatical form for both investigative and task-execution verbs (fetch/search/look up/check AND work on/start/fix/build/wrap up/finish): past-perfect ("I have fetched", "I have started fixing it"), bare past-tense ("I fetched", "I started on it"), present-continuous with subject ("I\'m fetching now", "I\'m checking", "I\'m working on it", "I\'m fixing it"), bare present-participle without subject ("Fetching latest info", "Looking it up", "Working on it", "Wrapping it up"), and "please hold" / "give me a sec" / "be right back" / "almost done" style stalling phrases.\n- messageToUser and REPLY text must NEVER fabricate a failure, error, or interruption that did not actually occur this turn. Do not claim something "glitched", "hiccuped", "broke", "went wrong", "snagged", "errored out", "got cut off", "didn\'t go through", "failed on my end", or invite the user to "give it another go / try that again / ask again" UNLESS a real tool call THIS turn actually returned an error or empty result. If you are choosing NOT to take an action this turn (no tool call in flight), do not invent a malfunction to excuse it: instead either (a) take the correct action (e.g. spawn the coding sub-agent for a build request), or (b) say plainly and truthfully what you can do and ask the user to confirm scope, e.g. "I can build that as a single-file site in its own folder, want me to start?". A fabricated "something glitched, give it another go" is a hallucinated failure and is forbidden when nothing failed. This covers every phrasing of a non-existent error or stall-and-retry invitation.\n- When a tool call produced actual output (stdout, fetched content, search results, file listings, command output), the subsequent messageToUser must include that output directly — do not replace it with a meta-summary of what the tool did. Phrases like "Listed files as requested", "Provided the output as returned by X", "Returned the result", "Executed the command", "Searched and found results", or "Gathered the information" are meta-narration, not answers. If the tool already returned user-friendly text (verifiedUserFacing is true), include that text in messageToUser rather than describing the action.\n\nIf context has "# Routing hints", follow them. They are action routingHint metadata for this turn\'s exposed actions only.',
                        stable: true,
                      },
                    ],
                    modelInputBudget: {
                      estimatedInputTokens: 27208,
                      contextWindowTokens: 128000,
                      reserveTokens: 10000,
                      compactionThresholdTokens: 118000,
                      shouldCompact: false,
                      resolvedModelKey: null,
                    },
                    thinking: "off",
                    plannerActionSchemas: {
                      REPLY: {
                        type: "object",
                        required: [],
                        properties: {
                          text: {
                            type: "string",
                            description:
                              "Reply text. Omit with questions absent to compose from state.",
                          },
                          questions: {
                            type: "array",
                            description:
                              "1-4 structured questions: { question, header, options?: [{label, description?, preview?}], multiSelect? }. Returns requiresUserInteraction: true.",
                            items: {
                              type: "object",
                              required: ["question", "header"],
                              properties: {
                                question: { type: "string" },
                                header: { type: "string" },
                                multiSelect: { type: "boolean" },
                                options: {
                                  type: "array",
                                  items: {
                                    type: "object",
                                    required: ["label"],
                                    properties: {
                                      label: { type: "string" },
                                      description: { type: "string" },
                                      preview: { type: "string" },
                                    },
                                    additionalProperties: false,
                                  },
                                },
                              },
                              additionalProperties: false,
                            },
                          },
                        },
                        additionalProperties: false,
                      },
                      IGNORE: {
                        type: "object",
                        required: [],
                        properties: {},
                        additionalProperties: false,
                      },
                      NONE: {
                        type: "object",
                        required: [],
                        properties: {},
                        additionalProperties: false,
                      },
                      PERSONALITY: {
                        type: "object",
                        required: ["action"],
                        properties: {
                          action: {
                            type: "string",
                            description:
                              "Canonical discriminator: which personality operation to run: set_trait, clear_trait, set_reply_gate, lift_reply_gate, add_directive, clear_directives...",
                            enum: [
                              "set_trait",
                              "clear_trait",
                              "set_reply_gate",
                              "lift_reply_gate",
                              "add_directive",
                              "clear_directives",
                              "load_profile",
                              "save_profile",
                              "list_profiles",
                              "show_state",
                            ],
                          },
                          op: {
                            type: "string",
                            description: "Legacy alias for `action`.",
                            enum: [
                              "set_trait",
                              "clear_trait",
                              "set_reply_gate",
                              "lift_reply_gate",
                              "add_directive",
                              "clear_directives",
                              "load_profile",
                              "save_profile",
                              "list_profiles",
                              "show_state",
                            ],
                          },
                          scope: {
                            type: "string",
                            description:
                              "Required for set_trait/clear_trait/set_reply_gate/lift_reply_gate/add_directive/clear_directives/show_state. Use 'user' for the requesting user's slot, or...",
                            enum: ["user", "global"],
                          },
                          trait: {
                            type: "string",
                            description:
                              "set_trait/clear_trait: which trait to modify. One of verbosity, tone, formality.",
                            enum: ["verbosity", "tone", "formality"],
                          },
                          value: {
                            type: "string",
                            description:
                              "set_trait: the new trait value. verbosity ∈ {terse, normal, verbose}. tone ∈ {warm, neutral, direct, cold}. formality ∈ {casual, professional, formal}.",
                          },
                          mode: {
                            type: "string",
                            description:
                              "set_reply_gate: gate mode. One of always, on_mention, never_until_lift. 'never_until_lift' is the canonical \"shut up\" mode.",
                            enum: ["always", "on_mention", "never_until_lift"],
                          },
                          directive: {
                            type: "string",
                            description:
                              "add_directive: a free-text directive to attach to user's slot (≤200 chars, ≤5 active directives, FIFO eviction).",
                          },
                          name: {
                            type: "string",
                            description:
                              "load_profile/save_profile: name of the named profile.",
                          },
                          description: {
                            type: "string",
                            description:
                              "save_profile: human-readable description of the profile.",
                          },
                        },
                        additionalProperties: false,
                      },
                      OWNER_FINANCES_DASHBOARD: {
                        type: "object",
                        required: [],
                        properties: {
                          action: {
                            type: "string",
                            description:
                              'Subaction discriminator (auto-set to "dashboard" for this virtual. do not change).',
                            enum: ["dashboard"],
                            default: "dashboard",
                          },
                          sourceId: {
                            type: "string",
                            description:
                              "Payment source UUID for scoped reads and CSV import.",
                          },
                          kind: {
                            type: "string",
                            description:
                              "add_source kind: csv | plaid | manual | paypal.",
                          },
                          label: {
                            type: "string",
                            description: "Human label when adding a source.",
                          },
                          institution: {
                            type: "string",
                            description: "Institution display name.",
                          },
                          accountMask: {
                            type: "string",
                            description: "Last-four or mask string.",
                          },
                          csvText: {
                            type: "string",
                            description: "Raw CSV payload for import_csv.",
                          },
                          dateColumn: {
                            type: "string",
                            description: "CSV column hint for posting date.",
                          },
                          amountColumn: {
                            type: "string",
                            description: "CSV column hint for amount.",
                          },
                          merchantColumn: {
                            type: "string",
                            description: "CSV column hint for merchant.",
                          },
                          descriptionColumn: {
                            type: "string",
                            description: "CSV column hint for description.",
                          },
                          categoryColumn: {
                            type: "string",
                            description: "CSV column hint for category.",
                          },
                          windowDays: {
                            type: "number",
                            description:
                              "Rolling window for dashboard or spending summaries.",
                          },
                          sinceDays: {
                            type: "number",
                            description:
                              "History window for recurring charge detection.",
                          },
                          limit: {
                            type: "number",
                            description: "Transaction row cap for listings.",
                          },
                          merchantContains: {
                            type: "string",
                            description:
                              "Filter transactions by merchant substring.",
                          },
                          onlyDebits: {
                            type: "boolean",
                            description:
                              "Exclude credits when listing transactions.",
                          },
                          serviceName: {
                            type: "string",
                            description:
                              "Display name of the subscription service.",
                          },
                          serviceSlug: {
                            type: "string",
                            description: "Normalized slug for routing.",
                          },
                          candidateId: {
                            type: "string",
                            description: "Internal audit candidate id.",
                          },
                          cancellationId: {
                            type: "string",
                            description:
                              "Ongoing cancellation id for status lookups.",
                          },
                          executor: {
                            type: "string",
                            description:
                              "Browser executor: user_browser | agent_browser | desktop_native.",
                          },
                          queryWindowDays: {
                            type: "number",
                            description: "Days of history for audit queries.",
                          },
                          confirmed: {
                            type: "boolean",
                            description:
                              "User confirmed cancellation prerequisites.",
                          },
                        },
                        additionalProperties: false,
                      },
                      OWNER_FINANCES_LIST_SOURCES: {
                        type: "object",
                        required: [],
                        properties: {
                          action: {
                            type: "string",
                            description:
                              'Subaction discriminator (auto-set to "list_sources" for this virtual. do not change).',
                            enum: ["list_sources"],
                            default: "list_sources",
                          },
                          sourceId: {
                            type: "string",
                            description:
                              "Payment source UUID for scoped reads and CSV import.",
                          },
                          kind: {
                            type: "string",
                            description:
                              "add_source kind: csv | plaid | manual | paypal.",
                          },
                          label: {
                            type: "string",
                            description: "Human label when adding a source.",
                          },
                          institution: {
                            type: "string",
                            description: "Institution display name.",
                          },
                          accountMask: {
                            type: "string",
                            description: "Last-four or mask string.",
                          },
                          csvText: {
                            type: "string",
                            description: "Raw CSV payload for import_csv.",
                          },
                          dateColumn: {
                            type: "string",
                            description: "CSV column hint for posting date.",
                          },
                          amountColumn: {
                            type: "string",
                            description: "CSV column hint for amount.",
                          },
                          merchantColumn: {
                            type: "string",
                            description: "CSV column hint for merchant.",
                          },
                          descriptionColumn: {
                            type: "string",
                            description: "CSV column hint for description.",
                          },
                          categoryColumn: {
                            type: "string",
                            description: "CSV column hint for category.",
                          },
                          windowDays: {
                            type: "number",
                            description:
                              "Rolling window for dashboard or spending summaries.",
                          },
                          sinceDays: {
                            type: "number",
                            description:
                              "History window for recurring charge detection.",
                          },
                          limit: {
                            type: "number",
                            description: "Transaction row cap for listings.",
                          },
                          merchantContains: {
                            type: "string",
                            description:
                              "Filter transactions by merchant substring.",
                          },
                          onlyDebits: {
                            type: "boolean",
                            description:
                              "Exclude credits when listing transactions.",
                          },
                          serviceName: {
                            type: "string",
                            description:
                              "Display name of the subscription service.",
                          },
                          serviceSlug: {
                            type: "string",
                            description: "Normalized slug for routing.",
                          },
                          candidateId: {
                            type: "string",
                            description: "Internal audit candidate id.",
                          },
                          cancellationId: {
                            type: "string",
                            description:
                              "Ongoing cancellation id for status lookups.",
                          },
                          executor: {
                            type: "string",
                            description:
                              "Browser executor: user_browser | agent_browser | desktop_native.",
                          },
                          queryWindowDays: {
                            type: "number",
                            description: "Days of history for audit queries.",
                          },
                          confirmed: {
                            type: "boolean",
                            description:
                              "User confirmed cancellation prerequisites.",
                          },
                        },
                        additionalProperties: false,
                      },
                      OWNER_FINANCES_ADD_SOURCE: {
                        type: "object",
                        required: [],
                        properties: {
                          action: {
                            type: "string",
                            description:
                              'Subaction discriminator (auto-set to "add_source" for this virtual. do not change).',
                            enum: ["add_source"],
                            default: "add_source",
                          },
                          sourceId: {
                            type: "string",
                            description:
                              "Payment source UUID for scoped reads and CSV import.",
                          },
                          kind: {
                            type: "string",
                            description:
                              "add_source kind: csv | plaid | manual | paypal.",
                          },
                          label: {
                            type: "string",
                            description: "Human label when adding a source.",
                          },
                          institution: {
                            type: "string",
                            description: "Institution display name.",
                          },
                          accountMask: {
                            type: "string",
                            description: "Last-four or mask string.",
                          },
                          csvText: {
                            type: "string",
                            description: "Raw CSV payload for import_csv.",
                          },
                          dateColumn: {
                            type: "string",
                            description: "CSV column hint for posting date.",
                          },
                          amountColumn: {
                            type: "string",
                            description: "CSV column hint for amount.",
                          },
                          merchantColumn: {
                            type: "string",
                            description: "CSV column hint for merchant.",
                          },
                          descriptionColumn: {
                            type: "string",
                            description: "CSV column hint for description.",
                          },
                          categoryColumn: {
                            type: "string",
                            description: "CSV column hint for category.",
                          },
                          windowDays: {
                            type: "number",
                            description:
                              "Rolling window for dashboard or spending summaries.",
                          },
                          sinceDays: {
                            type: "number",
                            description:
                              "History window for recurring charge detection.",
                          },
                          limit: {
                            type: "number",
                            description: "Transaction row cap for listings.",
                          },
                          merchantContains: {
                            type: "string",
                            description:
                              "Filter transactions by merchant substring.",
                          },
                          onlyDebits: {
                            type: "boolean",
                            description:
                              "Exclude credits when listing transactions.",
                          },
                          serviceName: {
                            type: "string",
                            description:
                              "Display name of the subscription service.",
                          },
                          serviceSlug: {
                            type: "string",
                            description: "Normalized slug for routing.",
                          },
                          candidateId: {
                            type: "string",
                            description: "Internal audit candidate id.",
                          },
                          cancellationId: {
                            type: "string",
                            description:
                              "Ongoing cancellation id for status lookups.",
                          },
                          executor: {
                            type: "string",
                            description:
                              "Browser executor: user_browser | agent_browser | desktop_native.",
                          },
                          queryWindowDays: {
                            type: "number",
                            description: "Days of history for audit queries.",
                          },
                          confirmed: {
                            type: "boolean",
                            description:
                              "User confirmed cancellation prerequisites.",
                          },
                        },
                        additionalProperties: false,
                      },
                      OWNER_FINANCES_REMOVE_SOURCE: {
                        type: "object",
                        required: [],
                        properties: {
                          action: {
                            type: "string",
                            description:
                              'Subaction discriminator (auto-set to "remove_source" for this virtual. do not change).',
                            enum: ["remove_source"],
                            default: "remove_source",
                          },
                          sourceId: {
                            type: "string",
                            description:
                              "Payment source UUID for scoped reads and CSV import.",
                          },
                          kind: {
                            type: "string",
                            description:
                              "add_source kind: csv | plaid | manual | paypal.",
                          },
                          label: {
                            type: "string",
                            description: "Human label when adding a source.",
                          },
                          institution: {
                            type: "string",
                            description: "Institution display name.",
                          },
                          accountMask: {
                            type: "string",
                            description: "Last-four or mask string.",
                          },
                          csvText: {
                            type: "string",
                            description: "Raw CSV payload for import_csv.",
                          },
                          dateColumn: {
                            type: "string",
                            description: "CSV column hint for posting date.",
                          },
                          amountColumn: {
                            type: "string",
                            description: "CSV column hint for amount.",
                          },
                          merchantColumn: {
                            type: "string",
                            description: "CSV column hint for merchant.",
                          },
                          descriptionColumn: {
                            type: "string",
                            description: "CSV column hint for description.",
                          },
                          categoryColumn: {
                            type: "string",
                            description: "CSV column hint for category.",
                          },
                          windowDays: {
                            type: "number",
                            description:
                              "Rolling window for dashboard or spending summaries.",
                          },
                          sinceDays: {
                            type: "number",
                            description:
                              "History window for recurring charge detection.",
                          },
                          limit: {
                            type: "number",
                            description: "Transaction row cap for listings.",
                          },
                          merchantContains: {
                            type: "string",
                            description:
                              "Filter transactions by merchant substring.",
                          },
                          onlyDebits: {
                            type: "boolean",
                            description:
                              "Exclude credits when listing transactions.",
                          },
                          serviceName: {
                            type: "string",
                            description:
                              "Display name of the subscription service.",
                          },
                          serviceSlug: {
                            type: "string",
                            description: "Normalized slug for routing.",
                          },
                          candidateId: {
                            type: "string",
                            description: "Internal audit candidate id.",
                          },
                          cancellationId: {
                            type: "string",
                            description:
                              "Ongoing cancellation id for status lookups.",
                          },
                          executor: {
                            type: "string",
                            description:
                              "Browser executor: user_browser | agent_browser | desktop_native.",
                          },
                          queryWindowDays: {
                            type: "number",
                            description: "Days of history for audit queries.",
                          },
                          confirmed: {
                            type: "boolean",
                            description:
                              "User confirmed cancellation prerequisites.",
                          },
                        },
                        additionalProperties: false,
                      },
                      OWNER_FINANCES_IMPORT_CSV: {
                        type: "object",
                        required: [],
                        properties: {
                          action: {
                            type: "string",
                            description:
                              'Subaction discriminator (auto-set to "import_csv" for this virtual. do not change).',
                            enum: ["import_csv"],
                            default: "import_csv",
                          },
                          sourceId: {
                            type: "string",
                            description:
                              "Payment source UUID for scoped reads and CSV import.",
                          },
                          kind: {
                            type: "string",
                            description:
                              "add_source kind: csv | plaid | manual | paypal.",
                          },
                          label: {
                            type: "string",
                            description: "Human label when adding a source.",
                          },
                          institution: {
                            type: "string",
                            description: "Institution display name.",
                          },
                          accountMask: {
                            type: "string",
                            description: "Last-four or mask string.",
                          },
                          csvText: {
                            type: "string",
                            description: "Raw CSV payload for import_csv.",
                          },
                          dateColumn: {
                            type: "string",
                            description: "CSV column hint for posting date.",
                          },
                          amountColumn: {
                            type: "string",
                            description: "CSV column hint for amount.",
                          },
                          merchantColumn: {
                            type: "string",
                            description: "CSV column hint for merchant.",
                          },
                          descriptionColumn: {
                            type: "string",
                            description: "CSV column hint for description.",
                          },
                          categoryColumn: {
                            type: "string",
                            description: "CSV column hint for category.",
                          },
                          windowDays: {
                            type: "number",
                            description:
                              "Rolling window for dashboard or spending summaries.",
                          },
                          sinceDays: {
                            type: "number",
                            description:
                              "History window for recurring charge detection.",
                          },
                          limit: {
                            type: "number",
                            description: "Transaction row cap for listings.",
                          },
                          merchantContains: {
                            type: "string",
                            description:
                              "Filter transactions by merchant substring.",
                          },
                          onlyDebits: {
                            type: "boolean",
                            description:
                              "Exclude credits when listing transactions.",
                          },
                          serviceName: {
                            type: "string",
                            description:
                              "Display name of the subscription service.",
                          },
                          serviceSlug: {
                            type: "string",
                            description: "Normalized slug for routing.",
                          },
                          candidateId: {
                            type: "string",
                            description: "Internal audit candidate id.",
                          },
                          cancellationId: {
                            type: "string",
                            description:
                              "Ongoing cancellation id for status lookups.",
                          },
                          executor: {
                            type: "string",
                            description:
                              "Browser executor: user_browser | agent_browser | desktop_native.",
                          },
                          queryWindowDays: {
                            type: "number",
                            description: "Days of history for audit queries.",
                          },
                          confirmed: {
                            type: "boolean",
                            description:
                              "User confirmed cancellation prerequisites.",
                          },
                        },
                        additionalProperties: false,
                      },
                      OWNER_FINANCES_LIST_TRANSACTIONS: {
                        type: "object",
                        required: [],
                        properties: {
                          action: {
                            type: "string",
                            description:
                              'Subaction discriminator (auto-set to "list_transactions" for this virtual. do not change).',
                            enum: ["list_transactions"],
                            default: "list_transactions",
                          },
                          sourceId: {
                            type: "string",
                            description:
                              "Payment source UUID for scoped reads and CSV import.",
                          },
                          kind: {
                            type: "string",
                            description:
                              "add_source kind: csv | plaid | manual | paypal.",
                          },
                          label: {
                            type: "string",
                            description: "Human label when adding a source.",
                          },
                          institution: {
                            type: "string",
                            description: "Institution display name.",
                          },
                          accountMask: {
                            type: "string",
                            description: "Last-four or mask string.",
                          },
                          csvText: {
                            type: "string",
                            description: "Raw CSV payload for import_csv.",
                          },
                          dateColumn: {
                            type: "string",
                            description: "CSV column hint for posting date.",
                          },
                          amountColumn: {
                            type: "string",
                            description: "CSV column hint for amount.",
                          },
                          merchantColumn: {
                            type: "string",
                            description: "CSV column hint for merchant.",
                          },
                          descriptionColumn: {
                            type: "string",
                            description: "CSV column hint for description.",
                          },
                          categoryColumn: {
                            type: "string",
                            description: "CSV column hint for category.",
                          },
                          windowDays: {
                            type: "number",
                            description:
                              "Rolling window for dashboard or spending summaries.",
                          },
                          sinceDays: {
                            type: "number",
                            description:
                              "History window for recurring charge detection.",
                          },
                          limit: {
                            type: "number",
                            description: "Transaction row cap for listings.",
                          },
                          merchantContains: {
                            type: "string",
                            description:
                              "Filter transactions by merchant substring.",
                          },
                          onlyDebits: {
                            type: "boolean",
                            description:
                              "Exclude credits when listing transactions.",
                          },
                          serviceName: {
                            type: "string",
                            description:
                              "Display name of the subscription service.",
                          },
                          serviceSlug: {
                            type: "string",
                            description: "Normalized slug for routing.",
                          },
                          candidateId: {
                            type: "string",
                            description: "Internal audit candidate id.",
                          },
                          cancellationId: {
                            type: "string",
                            description:
                              "Ongoing cancellation id for status lookups.",
                          },
                          executor: {
                            type: "string",
                            description:
                              "Browser executor: user_browser | agent_browser | desktop_native.",
                          },
                          queryWindowDays: {
                            type: "number",
                            description: "Days of history for audit queries.",
                          },
                          confirmed: {
                            type: "boolean",
                            description:
                              "User confirmed cancellation prerequisites.",
                          },
                        },
                        additionalProperties: false,
                      },
                      OWNER_FINANCES_RECURRING_CHARGES: {
                        type: "object",
                        required: [],
                        properties: {
                          action: {
                            type: "string",
                            description:
                              'Subaction discriminator (auto-set to "recurring_charges" for this virtual. do not change).',
                            enum: ["recurring_charges"],
                            default: "recurring_charges",
                          },
                          sourceId: {
                            type: "string",
                            description:
                              "Payment source UUID for scoped reads and CSV import.",
                          },
                          kind: {
                            type: "string",
                            description:
                              "add_source kind: csv | plaid | manual | paypal.",
                          },
                          label: {
                            type: "string",
                            description: "Human label when adding a source.",
                          },
                          institution: {
                            type: "string",
                            description: "Institution display name.",
                          },
                          accountMask: {
                            type: "string",
                            description: "Last-four or mask string.",
                          },
                          csvText: {
                            type: "string",
                            description: "Raw CSV payload for import_csv.",
                          },
                          dateColumn: {
                            type: "string",
                            description: "CSV column hint for posting date.",
                          },
                          amountColumn: {
                            type: "string",
                            description: "CSV column hint for amount.",
                          },
                          merchantColumn: {
                            type: "string",
                            description: "CSV column hint for merchant.",
                          },
                          descriptionColumn: {
                            type: "string",
                            description: "CSV column hint for description.",
                          },
                          categoryColumn: {
                            type: "string",
                            description: "CSV column hint for category.",
                          },
                          windowDays: {
                            type: "number",
                            description:
                              "Rolling window for dashboard or spending summaries.",
                          },
                          sinceDays: {
                            type: "number",
                            description:
                              "History window for recurring charge detection.",
                          },
                          limit: {
                            type: "number",
                            description: "Transaction row cap for listings.",
                          },
                          merchantContains: {
                            type: "string",
                            description:
                              "Filter transactions by merchant substring.",
                          },
                          onlyDebits: {
                            type: "boolean",
                            description:
                              "Exclude credits when listing transactions.",
                          },
                          serviceName: {
                            type: "string",
                            description:
                              "Display name of the subscription service.",
                          },
                          serviceSlug: {
                            type: "string",
                            description: "Normalized slug for routing.",
                          },
                          candidateId: {
                            type: "string",
                            description: "Internal audit candidate id.",
                          },
                          cancellationId: {
                            type: "string",
                            description:
                              "Ongoing cancellation id for status lookups.",
                          },
                          executor: {
                            type: "string",
                            description:
                              "Browser executor: user_browser | agent_browser | desktop_native.",
                          },
                          queryWindowDays: {
                            type: "number",
                            description: "Days of history for audit queries.",
                          },
                          confirmed: {
                            type: "boolean",
                            description:
                              "User confirmed cancellation prerequisites.",
                          },
                        },
                        additionalProperties: false,
                      },
                      CALENDAR: {
                        type: "object",
                        required: [],
                        properties: {
                          action: {
                            type: "string",
                            description:
                              "Calendar op. feed, next_event, search_events, create_event, update_event, delete_event, trip_window, bulk_reschedule, check_availability, propose_times...",
                            enum: [
                              "feed",
                              "next_event",
                              "search_events",
                              "create_event",
                              "update_event",
                              "delete_event",
                              "trip_window",
                              "bulk_reschedule",
                              "check_availability",
                              "propose_times",
                              "update_preferences",
                            ],
                          },
                          intent: {
                            type: "string",
                            description:
                              'Natural-language request. Examples: "calendar today", "flights this week", "create meeting tomorrow 3pm".',
                          },
                          title: {
                            type: "string",
                            description:
                              "title TOP-LEVEL; NOT details. create_event needs title + details.start/end",
                          },
                          query: {
                            type: "string",
                            description:
                              "Search phrase for search_events/travel_itinerary: flight, dentist, Denver.",
                          },
                          queries: {
                            type: "array",
                            description:
                              "Optional search_events phrases array. Combined/deduped.",
                            items: { type: "string" },
                          },
                          details: {
                            type: "object",
                            description:
                              "details create|update|delete: calendarId,start/end,eventId,location; title/window TOP",
                            required: [],
                            properties: {
                              calendarId: { type: "string" },
                              timeMin: { type: "string" },
                              timeMax: { type: "string" },
                              timeZone: { type: "string" },
                              forceSync: { type: "boolean" },
                              windowDays: { type: "number" },
                              windowPreset: { type: "string" },
                              start: { type: "string" },
                              end: { type: "string" },
                              startAt: { type: "string" },
                              endAt: { type: "string" },
                              durationMinutes: { type: "number" },
                              eventId: { type: "string" },
                              newTitle: { type: "string" },
                              description: { type: "string" },
                              location: { type: "string" },
                              travelOriginAddress: { type: "string" },
                              attendees: {
                                type: "array",
                                items: { type: "string" },
                              },
                            },
                            additionalProperties: false,
                          },
                          durationMinutes: {
                            type: "number",
                            description:
                              "TOP-LEVEL flat. propose_times length minutes. Example: `{ subaction: 'propose_times', durationMinutes: 30, slotCount: 3, windowStart: '...', windowEnd: '...'...",
                          },
                          daysAhead: {
                            type: "number",
                            description:
                              "propose_times days ahead. Default 7. Ignored with windowStart/windowEnd.",
                          },
                          slotCount: {
                            type: "number",
                            description: "propose_times slot count. Default 3.",
                          },
                          windowStart: {
                            type: "string",
                            description:
                              "propose_times window earliest start. ISO-8601.",
                          },
                          windowEnd: {
                            type: "string",
                            description:
                              "propose_times window latest end. ISO-8601.",
                          },
                          startAt: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat. check_availability start. ISO-8601. Example: `{ subaction: 'check_availability', startAt: '2026-05-14T09:00:00Z', endAt...",
                          },
                          endAt: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat. check_availability end. ISO-8601. See `startAt`.",
                          },
                          timeZone: {
                            type: "string",
                            description:
                              "IANA timeZone for update_preferences hours.",
                          },
                          preferredStartLocal: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat for update_preferences. Earliest start local HH:MM 24h. Example: `{ subaction: 'update_preferences', preferredStartLocal: '09:00'...",
                          },
                          preferredEndLocal: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat for update_preferences. Latest end local HH:MM 24h. See `preferredStartLocal`.",
                          },
                          defaultDurationMinutes: {
                            type: "number",
                            description: "Default duration minutes (5-480).",
                          },
                          travelBufferMinutes: {
                            type: "number",
                            description:
                              "Buffer minutes before/after meetings (0-240).",
                          },
                          blackoutWindows: {
                            type: "array",
                            description:
                              "blackoutWindows[]: label startLocal HH:MM endLocal HH:MM daysOfWeek?[0..6]",
                            items: {
                              type: "object",
                              required: ["label", "startLocal", "endLocal"],
                              properties: {
                                label: { type: "string" },
                                startLocal: {
                                  type: "string",
                                  pattern: "^[0-2][0-9]:[0-5][0-9]$",
                                },
                                endLocal: {
                                  type: "string",
                                  pattern: "^[0-2][0-9]:[0-5][0-9]$",
                                },
                                daysOfWeek: {
                                  type: "array",
                                  items: {
                                    type: "number",
                                    minimum: 0,
                                    maximum: 6,
                                  },
                                },
                              },
                              additionalProperties: false,
                            },
                          },
                        },
                        additionalProperties: false,
                      },
                      CALENDAR_FEED: {
                        type: "object",
                        required: [],
                        properties: {
                          action: {
                            type: "string",
                            description:
                              'Subaction discriminator (auto-set to "feed" for this virtual. do not change).',
                            enum: ["feed"],
                            default: "feed",
                          },
                          intent: {
                            type: "string",
                            description:
                              'Natural-language request. Examples: "calendar today", "flights this week", "create meeting tomorrow 3pm".',
                          },
                          title: {
                            type: "string",
                            description:
                              "title TOP-LEVEL; NOT details. create_event needs title + details.start/end",
                          },
                          query: {
                            type: "string",
                            description:
                              "Search phrase for search_events/travel_itinerary: flight, dentist, Denver.",
                          },
                          queries: {
                            type: "array",
                            description:
                              "Optional search_events phrases array. Combined/deduped.",
                            items: { type: "string" },
                          },
                          details: {
                            type: "object",
                            description:
                              "details create|update|delete: calendarId,start/end,eventId,location; title/window TOP",
                            required: [],
                            properties: {
                              calendarId: { type: "string" },
                              timeMin: { type: "string" },
                              timeMax: { type: "string" },
                              timeZone: { type: "string" },
                              forceSync: { type: "boolean" },
                              windowDays: { type: "number" },
                              windowPreset: { type: "string" },
                              start: { type: "string" },
                              end: { type: "string" },
                              startAt: { type: "string" },
                              endAt: { type: "string" },
                              durationMinutes: { type: "number" },
                              eventId: { type: "string" },
                              newTitle: { type: "string" },
                              description: { type: "string" },
                              location: { type: "string" },
                              travelOriginAddress: { type: "string" },
                              attendees: {
                                type: "array",
                                items: { type: "string" },
                              },
                            },
                            additionalProperties: false,
                          },
                          durationMinutes: {
                            type: "number",
                            description:
                              "TOP-LEVEL flat. propose_times length minutes. Example: `{ subaction: 'propose_times', durationMinutes: 30, slotCount: 3, windowStart: '...', windowEnd: '...'...",
                          },
                          daysAhead: {
                            type: "number",
                            description:
                              "propose_times days ahead. Default 7. Ignored with windowStart/windowEnd.",
                          },
                          slotCount: {
                            type: "number",
                            description: "propose_times slot count. Default 3.",
                          },
                          windowStart: {
                            type: "string",
                            description:
                              "propose_times window earliest start. ISO-8601.",
                          },
                          windowEnd: {
                            type: "string",
                            description:
                              "propose_times window latest end. ISO-8601.",
                          },
                          startAt: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat. check_availability start. ISO-8601. Example: `{ subaction: 'check_availability', startAt: '2026-05-14T09:00:00Z', endAt...",
                          },
                          endAt: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat. check_availability end. ISO-8601. See `startAt`.",
                          },
                          timeZone: {
                            type: "string",
                            description:
                              "IANA timeZone for update_preferences hours.",
                          },
                          preferredStartLocal: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat for update_preferences. Earliest start local HH:MM 24h. Example: `{ subaction: 'update_preferences', preferredStartLocal: '09:00'...",
                          },
                          preferredEndLocal: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat for update_preferences. Latest end local HH:MM 24h. See `preferredStartLocal`.",
                          },
                          defaultDurationMinutes: {
                            type: "number",
                            description: "Default duration minutes (5-480).",
                          },
                          travelBufferMinutes: {
                            type: "number",
                            description:
                              "Buffer minutes before/after meetings (0-240).",
                          },
                          blackoutWindows: {
                            type: "array",
                            description:
                              "blackoutWindows[]: label startLocal HH:MM endLocal HH:MM daysOfWeek?[0..6]",
                            items: {
                              type: "object",
                              required: ["label", "startLocal", "endLocal"],
                              properties: {
                                label: { type: "string" },
                                startLocal: {
                                  type: "string",
                                  pattern: "^[0-2][0-9]:[0-5][0-9]$",
                                },
                                endLocal: {
                                  type: "string",
                                  pattern: "^[0-2][0-9]:[0-5][0-9]$",
                                },
                                daysOfWeek: {
                                  type: "array",
                                  items: {
                                    type: "number",
                                    minimum: 0,
                                    maximum: 6,
                                  },
                                },
                              },
                              additionalProperties: false,
                            },
                          },
                        },
                        additionalProperties: false,
                      },
                      CALENDAR_NEXT_EVENT: {
                        type: "object",
                        required: [],
                        properties: {
                          action: {
                            type: "string",
                            description:
                              'Subaction discriminator (auto-set to "next_event" for this virtual. do not change).',
                            enum: ["next_event"],
                            default: "next_event",
                          },
                          intent: {
                            type: "string",
                            description:
                              'Natural-language request. Examples: "calendar today", "flights this week", "create meeting tomorrow 3pm".',
                          },
                          title: {
                            type: "string",
                            description:
                              "title TOP-LEVEL; NOT details. create_event needs title + details.start/end",
                          },
                          query: {
                            type: "string",
                            description:
                              "Search phrase for search_events/travel_itinerary: flight, dentist, Denver.",
                          },
                          queries: {
                            type: "array",
                            description:
                              "Optional search_events phrases array. Combined/deduped.",
                            items: { type: "string" },
                          },
                          details: {
                            type: "object",
                            description:
                              "details create|update|delete: calendarId,start/end,eventId,location; title/window TOP",
                            required: [],
                            properties: {
                              calendarId: { type: "string" },
                              timeMin: { type: "string" },
                              timeMax: { type: "string" },
                              timeZone: { type: "string" },
                              forceSync: { type: "boolean" },
                              windowDays: { type: "number" },
                              windowPreset: { type: "string" },
                              start: { type: "string" },
                              end: { type: "string" },
                              startAt: { type: "string" },
                              endAt: { type: "string" },
                              durationMinutes: { type: "number" },
                              eventId: { type: "string" },
                              newTitle: { type: "string" },
                              description: { type: "string" },
                              location: { type: "string" },
                              travelOriginAddress: { type: "string" },
                              attendees: {
                                type: "array",
                                items: { type: "string" },
                              },
                            },
                            additionalProperties: false,
                          },
                          durationMinutes: {
                            type: "number",
                            description:
                              "TOP-LEVEL flat. propose_times length minutes. Example: `{ subaction: 'propose_times', durationMinutes: 30, slotCount: 3, windowStart: '...', windowEnd: '...'...",
                          },
                          daysAhead: {
                            type: "number",
                            description:
                              "propose_times days ahead. Default 7. Ignored with windowStart/windowEnd.",
                          },
                          slotCount: {
                            type: "number",
                            description: "propose_times slot count. Default 3.",
                          },
                          windowStart: {
                            type: "string",
                            description:
                              "propose_times window earliest start. ISO-8601.",
                          },
                          windowEnd: {
                            type: "string",
                            description:
                              "propose_times window latest end. ISO-8601.",
                          },
                          startAt: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat. check_availability start. ISO-8601. Example: `{ subaction: 'check_availability', startAt: '2026-05-14T09:00:00Z', endAt...",
                          },
                          endAt: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat. check_availability end. ISO-8601. See `startAt`.",
                          },
                          timeZone: {
                            type: "string",
                            description:
                              "IANA timeZone for update_preferences hours.",
                          },
                          preferredStartLocal: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat for update_preferences. Earliest start local HH:MM 24h. Example: `{ subaction: 'update_preferences', preferredStartLocal: '09:00'...",
                          },
                          preferredEndLocal: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat for update_preferences. Latest end local HH:MM 24h. See `preferredStartLocal`.",
                          },
                          defaultDurationMinutes: {
                            type: "number",
                            description: "Default duration minutes (5-480).",
                          },
                          travelBufferMinutes: {
                            type: "number",
                            description:
                              "Buffer minutes before/after meetings (0-240).",
                          },
                          blackoutWindows: {
                            type: "array",
                            description:
                              "blackoutWindows[]: label startLocal HH:MM endLocal HH:MM daysOfWeek?[0..6]",
                            items: {
                              type: "object",
                              required: ["label", "startLocal", "endLocal"],
                              properties: {
                                label: { type: "string" },
                                startLocal: {
                                  type: "string",
                                  pattern: "^[0-2][0-9]:[0-5][0-9]$",
                                },
                                endLocal: {
                                  type: "string",
                                  pattern: "^[0-2][0-9]:[0-5][0-9]$",
                                },
                                daysOfWeek: {
                                  type: "array",
                                  items: {
                                    type: "number",
                                    minimum: 0,
                                    maximum: 6,
                                  },
                                },
                              },
                              additionalProperties: false,
                            },
                          },
                        },
                        additionalProperties: false,
                      },
                      CALENDAR_SEARCH_EVENTS: {
                        type: "object",
                        required: [],
                        properties: {
                          action: {
                            type: "string",
                            description:
                              'Subaction discriminator (auto-set to "search_events" for this virtual. do not change).',
                            enum: ["search_events"],
                            default: "search_events",
                          },
                          intent: {
                            type: "string",
                            description:
                              'Natural-language request. Examples: "calendar today", "flights this week", "create meeting tomorrow 3pm".',
                          },
                          title: {
                            type: "string",
                            description:
                              "title TOP-LEVEL; NOT details. create_event needs title + details.start/end",
                          },
                          query: {
                            type: "string",
                            description:
                              "Search phrase for search_events/travel_itinerary: flight, dentist, Denver.",
                          },
                          queries: {
                            type: "array",
                            description:
                              "Optional search_events phrases array. Combined/deduped.",
                            items: { type: "string" },
                          },
                          details: {
                            type: "object",
                            description:
                              "details create|update|delete: calendarId,start/end,eventId,location; title/window TOP",
                            required: [],
                            properties: {
                              calendarId: { type: "string" },
                              timeMin: { type: "string" },
                              timeMax: { type: "string" },
                              timeZone: { type: "string" },
                              forceSync: { type: "boolean" },
                              windowDays: { type: "number" },
                              windowPreset: { type: "string" },
                              start: { type: "string" },
                              end: { type: "string" },
                              startAt: { type: "string" },
                              endAt: { type: "string" },
                              durationMinutes: { type: "number" },
                              eventId: { type: "string" },
                              newTitle: { type: "string" },
                              description: { type: "string" },
                              location: { type: "string" },
                              travelOriginAddress: { type: "string" },
                              attendees: {
                                type: "array",
                                items: { type: "string" },
                              },
                            },
                            additionalProperties: false,
                          },
                          durationMinutes: {
                            type: "number",
                            description:
                              "TOP-LEVEL flat. propose_times length minutes. Example: `{ subaction: 'propose_times', durationMinutes: 30, slotCount: 3, windowStart: '...', windowEnd: '...'...",
                          },
                          daysAhead: {
                            type: "number",
                            description:
                              "propose_times days ahead. Default 7. Ignored with windowStart/windowEnd.",
                          },
                          slotCount: {
                            type: "number",
                            description: "propose_times slot count. Default 3.",
                          },
                          windowStart: {
                            type: "string",
                            description:
                              "propose_times window earliest start. ISO-8601.",
                          },
                          windowEnd: {
                            type: "string",
                            description:
                              "propose_times window latest end. ISO-8601.",
                          },
                          startAt: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat. check_availability start. ISO-8601. Example: `{ subaction: 'check_availability', startAt: '2026-05-14T09:00:00Z', endAt...",
                          },
                          endAt: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat. check_availability end. ISO-8601. See `startAt`.",
                          },
                          timeZone: {
                            type: "string",
                            description:
                              "IANA timeZone for update_preferences hours.",
                          },
                          preferredStartLocal: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat for update_preferences. Earliest start local HH:MM 24h. Example: `{ subaction: 'update_preferences', preferredStartLocal: '09:00'...",
                          },
                          preferredEndLocal: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat for update_preferences. Latest end local HH:MM 24h. See `preferredStartLocal`.",
                          },
                          defaultDurationMinutes: {
                            type: "number",
                            description: "Default duration minutes (5-480).",
                          },
                          travelBufferMinutes: {
                            type: "number",
                            description:
                              "Buffer minutes before/after meetings (0-240).",
                          },
                          blackoutWindows: {
                            type: "array",
                            description:
                              "blackoutWindows[]: label startLocal HH:MM endLocal HH:MM daysOfWeek?[0..6]",
                            items: {
                              type: "object",
                              required: ["label", "startLocal", "endLocal"],
                              properties: {
                                label: { type: "string" },
                                startLocal: {
                                  type: "string",
                                  pattern: "^[0-2][0-9]:[0-5][0-9]$",
                                },
                                endLocal: {
                                  type: "string",
                                  pattern: "^[0-2][0-9]:[0-5][0-9]$",
                                },
                                daysOfWeek: {
                                  type: "array",
                                  items: {
                                    type: "number",
                                    minimum: 0,
                                    maximum: 6,
                                  },
                                },
                              },
                              additionalProperties: false,
                            },
                          },
                        },
                        additionalProperties: false,
                      },
                      CALENDAR_CREATE_EVENT: {
                        type: "object",
                        required: [],
                        properties: {
                          action: {
                            type: "string",
                            description:
                              'Subaction discriminator (auto-set to "create_event" for this virtual. do not change).',
                            enum: ["create_event"],
                            default: "create_event",
                          },
                          intent: {
                            type: "string",
                            description:
                              'Natural-language request. Examples: "calendar today", "flights this week", "create meeting tomorrow 3pm".',
                          },
                          title: {
                            type: "string",
                            description:
                              "title TOP-LEVEL; NOT details. create_event needs title + details.start/end",
                          },
                          query: {
                            type: "string",
                            description:
                              "Search phrase for search_events/travel_itinerary: flight, dentist, Denver.",
                          },
                          queries: {
                            type: "array",
                            description:
                              "Optional search_events phrases array. Combined/deduped.",
                            items: { type: "string" },
                          },
                          details: {
                            type: "object",
                            description:
                              "details create|update|delete: calendarId,start/end,eventId,location; title/window TOP",
                            required: [],
                            properties: {
                              calendarId: { type: "string" },
                              timeMin: { type: "string" },
                              timeMax: { type: "string" },
                              timeZone: { type: "string" },
                              forceSync: { type: "boolean" },
                              windowDays: { type: "number" },
                              windowPreset: { type: "string" },
                              start: { type: "string" },
                              end: { type: "string" },
                              startAt: { type: "string" },
                              endAt: { type: "string" },
                              durationMinutes: { type: "number" },
                              eventId: { type: "string" },
                              newTitle: { type: "string" },
                              description: { type: "string" },
                              location: { type: "string" },
                              travelOriginAddress: { type: "string" },
                              attendees: {
                                type: "array",
                                items: { type: "string" },
                              },
                            },
                            additionalProperties: false,
                          },
                          durationMinutes: {
                            type: "number",
                            description:
                              "TOP-LEVEL flat. propose_times length minutes. Example: `{ subaction: 'propose_times', durationMinutes: 30, slotCount: 3, windowStart: '...', windowEnd: '...'...",
                          },
                          daysAhead: {
                            type: "number",
                            description:
                              "propose_times days ahead. Default 7. Ignored with windowStart/windowEnd.",
                          },
                          slotCount: {
                            type: "number",
                            description: "propose_times slot count. Default 3.",
                          },
                          windowStart: {
                            type: "string",
                            description:
                              "propose_times window earliest start. ISO-8601.",
                          },
                          windowEnd: {
                            type: "string",
                            description:
                              "propose_times window latest end. ISO-8601.",
                          },
                          startAt: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat. check_availability start. ISO-8601. Example: `{ subaction: 'check_availability', startAt: '2026-05-14T09:00:00Z', endAt...",
                          },
                          endAt: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat. check_availability end. ISO-8601. See `startAt`.",
                          },
                          timeZone: {
                            type: "string",
                            description:
                              "IANA timeZone for update_preferences hours.",
                          },
                          preferredStartLocal: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat for update_preferences. Earliest start local HH:MM 24h. Example: `{ subaction: 'update_preferences', preferredStartLocal: '09:00'...",
                          },
                          preferredEndLocal: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat for update_preferences. Latest end local HH:MM 24h. See `preferredStartLocal`.",
                          },
                          defaultDurationMinutes: {
                            type: "number",
                            description: "Default duration minutes (5-480).",
                          },
                          travelBufferMinutes: {
                            type: "number",
                            description:
                              "Buffer minutes before/after meetings (0-240).",
                          },
                          blackoutWindows: {
                            type: "array",
                            description:
                              "blackoutWindows[]: label startLocal HH:MM endLocal HH:MM daysOfWeek?[0..6]",
                            items: {
                              type: "object",
                              required: ["label", "startLocal", "endLocal"],
                              properties: {
                                label: { type: "string" },
                                startLocal: {
                                  type: "string",
                                  pattern: "^[0-2][0-9]:[0-5][0-9]$",
                                },
                                endLocal: {
                                  type: "string",
                                  pattern: "^[0-2][0-9]:[0-5][0-9]$",
                                },
                                daysOfWeek: {
                                  type: "array",
                                  items: {
                                    type: "number",
                                    minimum: 0,
                                    maximum: 6,
                                  },
                                },
                              },
                              additionalProperties: false,
                            },
                          },
                        },
                        additionalProperties: false,
                      },
                      CALENDAR_UPDATE_EVENT: {
                        type: "object",
                        required: [],
                        properties: {
                          action: {
                            type: "string",
                            description:
                              'Subaction discriminator (auto-set to "update_event" for this virtual. do not change).',
                            enum: ["update_event"],
                            default: "update_event",
                          },
                          intent: {
                            type: "string",
                            description:
                              'Natural-language request. Examples: "calendar today", "flights this week", "create meeting tomorrow 3pm".',
                          },
                          title: {
                            type: "string",
                            description:
                              "title TOP-LEVEL; NOT details. create_event needs title + details.start/end",
                          },
                          query: {
                            type: "string",
                            description:
                              "Search phrase for search_events/travel_itinerary: flight, dentist, Denver.",
                          },
                          queries: {
                            type: "array",
                            description:
                              "Optional search_events phrases array. Combined/deduped.",
                            items: { type: "string" },
                          },
                          details: {
                            type: "object",
                            description:
                              "details create|update|delete: calendarId,start/end,eventId,location; title/window TOP",
                            required: [],
                            properties: {
                              calendarId: { type: "string" },
                              timeMin: { type: "string" },
                              timeMax: { type: "string" },
                              timeZone: { type: "string" },
                              forceSync: { type: "boolean" },
                              windowDays: { type: "number" },
                              windowPreset: { type: "string" },
                              start: { type: "string" },
                              end: { type: "string" },
                              startAt: { type: "string" },
                              endAt: { type: "string" },
                              durationMinutes: { type: "number" },
                              eventId: { type: "string" },
                              newTitle: { type: "string" },
                              description: { type: "string" },
                              location: { type: "string" },
                              travelOriginAddress: { type: "string" },
                              attendees: {
                                type: "array",
                                items: { type: "string" },
                              },
                            },
                            additionalProperties: false,
                          },
                          durationMinutes: {
                            type: "number",
                            description:
                              "TOP-LEVEL flat. propose_times length minutes. Example: `{ subaction: 'propose_times', durationMinutes: 30, slotCount: 3, windowStart: '...', windowEnd: '...'...",
                          },
                          daysAhead: {
                            type: "number",
                            description:
                              "propose_times days ahead. Default 7. Ignored with windowStart/windowEnd.",
                          },
                          slotCount: {
                            type: "number",
                            description: "propose_times slot count. Default 3.",
                          },
                          windowStart: {
                            type: "string",
                            description:
                              "propose_times window earliest start. ISO-8601.",
                          },
                          windowEnd: {
                            type: "string",
                            description:
                              "propose_times window latest end. ISO-8601.",
                          },
                          startAt: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat. check_availability start. ISO-8601. Example: `{ subaction: 'check_availability', startAt: '2026-05-14T09:00:00Z', endAt...",
                          },
                          endAt: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat. check_availability end. ISO-8601. See `startAt`.",
                          },
                          timeZone: {
                            type: "string",
                            description:
                              "IANA timeZone for update_preferences hours.",
                          },
                          preferredStartLocal: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat for update_preferences. Earliest start local HH:MM 24h. Example: `{ subaction: 'update_preferences', preferredStartLocal: '09:00'...",
                          },
                          preferredEndLocal: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat for update_preferences. Latest end local HH:MM 24h. See `preferredStartLocal`.",
                          },
                          defaultDurationMinutes: {
                            type: "number",
                            description: "Default duration minutes (5-480).",
                          },
                          travelBufferMinutes: {
                            type: "number",
                            description:
                              "Buffer minutes before/after meetings (0-240).",
                          },
                          blackoutWindows: {
                            type: "array",
                            description:
                              "blackoutWindows[]: label startLocal HH:MM endLocal HH:MM daysOfWeek?[0..6]",
                            items: {
                              type: "object",
                              required: ["label", "startLocal", "endLocal"],
                              properties: {
                                label: { type: "string" },
                                startLocal: {
                                  type: "string",
                                  pattern: "^[0-2][0-9]:[0-5][0-9]$",
                                },
                                endLocal: {
                                  type: "string",
                                  pattern: "^[0-2][0-9]:[0-5][0-9]$",
                                },
                                daysOfWeek: {
                                  type: "array",
                                  items: {
                                    type: "number",
                                    minimum: 0,
                                    maximum: 6,
                                  },
                                },
                              },
                              additionalProperties: false,
                            },
                          },
                        },
                        additionalProperties: false,
                      },
                      CALENDAR_DELETE_EVENT: {
                        type: "object",
                        required: [],
                        properties: {
                          action: {
                            type: "string",
                            description:
                              'Subaction discriminator (auto-set to "delete_event" for this virtual. do not change).',
                            enum: ["delete_event"],
                            default: "delete_event",
                          },
                          intent: {
                            type: "string",
                            description:
                              'Natural-language request. Examples: "calendar today", "flights this week", "create meeting tomorrow 3pm".',
                          },
                          title: {
                            type: "string",
                            description:
                              "title TOP-LEVEL; NOT details. create_event needs title + details.start/end",
                          },
                          query: {
                            type: "string",
                            description:
                              "Search phrase for search_events/travel_itinerary: flight, dentist, Denver.",
                          },
                          queries: {
                            type: "array",
                            description:
                              "Optional search_events phrases array. Combined/deduped.",
                            items: { type: "string" },
                          },
                          details: {
                            type: "object",
                            description:
                              "details create|update|delete: calendarId,start/end,eventId,location; title/window TOP",
                            required: [],
                            properties: {
                              calendarId: { type: "string" },
                              timeMin: { type: "string" },
                              timeMax: { type: "string" },
                              timeZone: { type: "string" },
                              forceSync: { type: "boolean" },
                              windowDays: { type: "number" },
                              windowPreset: { type: "string" },
                              start: { type: "string" },
                              end: { type: "string" },
                              startAt: { type: "string" },
                              endAt: { type: "string" },
                              durationMinutes: { type: "number" },
                              eventId: { type: "string" },
                              newTitle: { type: "string" },
                              description: { type: "string" },
                              location: { type: "string" },
                              travelOriginAddress: { type: "string" },
                              attendees: {
                                type: "array",
                                items: { type: "string" },
                              },
                            },
                            additionalProperties: false,
                          },
                          durationMinutes: {
                            type: "number",
                            description:
                              "TOP-LEVEL flat. propose_times length minutes. Example: `{ subaction: 'propose_times', durationMinutes: 30, slotCount: 3, windowStart: '...', windowEnd: '...'...",
                          },
                          daysAhead: {
                            type: "number",
                            description:
                              "propose_times days ahead. Default 7. Ignored with windowStart/windowEnd.",
                          },
                          slotCount: {
                            type: "number",
                            description: "propose_times slot count. Default 3.",
                          },
                          windowStart: {
                            type: "string",
                            description:
                              "propose_times window earliest start. ISO-8601.",
                          },
                          windowEnd: {
                            type: "string",
                            description:
                              "propose_times window latest end. ISO-8601.",
                          },
                          startAt: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat. check_availability start. ISO-8601. Example: `{ subaction: 'check_availability', startAt: '2026-05-14T09:00:00Z', endAt...",
                          },
                          endAt: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat. check_availability end. ISO-8601. See `startAt`.",
                          },
                          timeZone: {
                            type: "string",
                            description:
                              "IANA timeZone for update_preferences hours.",
                          },
                          preferredStartLocal: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat for update_preferences. Earliest start local HH:MM 24h. Example: `{ subaction: 'update_preferences', preferredStartLocal: '09:00'...",
                          },
                          preferredEndLocal: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat for update_preferences. Latest end local HH:MM 24h. See `preferredStartLocal`.",
                          },
                          defaultDurationMinutes: {
                            type: "number",
                            description: "Default duration minutes (5-480).",
                          },
                          travelBufferMinutes: {
                            type: "number",
                            description:
                              "Buffer minutes before/after meetings (0-240).",
                          },
                          blackoutWindows: {
                            type: "array",
                            description:
                              "blackoutWindows[]: label startLocal HH:MM endLocal HH:MM daysOfWeek?[0..6]",
                            items: {
                              type: "object",
                              required: ["label", "startLocal", "endLocal"],
                              properties: {
                                label: { type: "string" },
                                startLocal: {
                                  type: "string",
                                  pattern: "^[0-2][0-9]:[0-5][0-9]$",
                                },
                                endLocal: {
                                  type: "string",
                                  pattern: "^[0-2][0-9]:[0-5][0-9]$",
                                },
                                daysOfWeek: {
                                  type: "array",
                                  items: {
                                    type: "number",
                                    minimum: 0,
                                    maximum: 6,
                                  },
                                },
                              },
                              additionalProperties: false,
                            },
                          },
                        },
                        additionalProperties: false,
                      },
                      CALENDAR_TRIP_WINDOW: {
                        type: "object",
                        required: [],
                        properties: {
                          action: {
                            type: "string",
                            description:
                              'Subaction discriminator (auto-set to "trip_window" for this virtual. do not change).',
                            enum: ["trip_window"],
                            default: "trip_window",
                          },
                          intent: {
                            type: "string",
                            description:
                              'Natural-language request. Examples: "calendar today", "flights this week", "create meeting tomorrow 3pm".',
                          },
                          title: {
                            type: "string",
                            description:
                              "title TOP-LEVEL; NOT details. create_event needs title + details.start/end",
                          },
                          query: {
                            type: "string",
                            description:
                              "Search phrase for search_events/travel_itinerary: flight, dentist, Denver.",
                          },
                          queries: {
                            type: "array",
                            description:
                              "Optional search_events phrases array. Combined/deduped.",
                            items: { type: "string" },
                          },
                          details: {
                            type: "object",
                            description:
                              "details create|update|delete: calendarId,start/end,eventId,location; title/window TOP",
                            required: [],
                            properties: {
                              calendarId: { type: "string" },
                              timeMin: { type: "string" },
                              timeMax: { type: "string" },
                              timeZone: { type: "string" },
                              forceSync: { type: "boolean" },
                              windowDays: { type: "number" },
                              windowPreset: { type: "string" },
                              start: { type: "string" },
                              end: { type: "string" },
                              startAt: { type: "string" },
                              endAt: { type: "string" },
                              durationMinutes: { type: "number" },
                              eventId: { type: "string" },
                              newTitle: { type: "string" },
                              description: { type: "string" },
                              location: { type: "string" },
                              travelOriginAddress: { type: "string" },
                              attendees: {
                                type: "array",
                                items: { type: "string" },
                              },
                            },
                            additionalProperties: false,
                          },
                          durationMinutes: {
                            type: "number",
                            description:
                              "TOP-LEVEL flat. propose_times length minutes. Example: `{ subaction: 'propose_times', durationMinutes: 30, slotCount: 3, windowStart: '...', windowEnd: '...'...",
                          },
                          daysAhead: {
                            type: "number",
                            description:
                              "propose_times days ahead. Default 7. Ignored with windowStart/windowEnd.",
                          },
                          slotCount: {
                            type: "number",
                            description: "propose_times slot count. Default 3.",
                          },
                          windowStart: {
                            type: "string",
                            description:
                              "propose_times window earliest start. ISO-8601.",
                          },
                          windowEnd: {
                            type: "string",
                            description:
                              "propose_times window latest end. ISO-8601.",
                          },
                          startAt: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat. check_availability start. ISO-8601. Example: `{ subaction: 'check_availability', startAt: '2026-05-14T09:00:00Z', endAt...",
                          },
                          endAt: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat. check_availability end. ISO-8601. See `startAt`.",
                          },
                          timeZone: {
                            type: "string",
                            description:
                              "IANA timeZone for update_preferences hours.",
                          },
                          preferredStartLocal: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat for update_preferences. Earliest start local HH:MM 24h. Example: `{ subaction: 'update_preferences', preferredStartLocal: '09:00'...",
                          },
                          preferredEndLocal: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat for update_preferences. Latest end local HH:MM 24h. See `preferredStartLocal`.",
                          },
                          defaultDurationMinutes: {
                            type: "number",
                            description: "Default duration minutes (5-480).",
                          },
                          travelBufferMinutes: {
                            type: "number",
                            description:
                              "Buffer minutes before/after meetings (0-240).",
                          },
                          blackoutWindows: {
                            type: "array",
                            description:
                              "blackoutWindows[]: label startLocal HH:MM endLocal HH:MM daysOfWeek?[0..6]",
                            items: {
                              type: "object",
                              required: ["label", "startLocal", "endLocal"],
                              properties: {
                                label: { type: "string" },
                                startLocal: {
                                  type: "string",
                                  pattern: "^[0-2][0-9]:[0-5][0-9]$",
                                },
                                endLocal: {
                                  type: "string",
                                  pattern: "^[0-2][0-9]:[0-5][0-9]$",
                                },
                                daysOfWeek: {
                                  type: "array",
                                  items: {
                                    type: "number",
                                    minimum: 0,
                                    maximum: 6,
                                  },
                                },
                              },
                              additionalProperties: false,
                            },
                          },
                        },
                        additionalProperties: false,
                      },
                      CALENDAR_BULK_RESCHEDULE: {
                        type: "object",
                        required: [],
                        properties: {
                          action: {
                            type: "string",
                            description:
                              'Subaction discriminator (auto-set to "bulk_reschedule" for this virtual. do not change).',
                            enum: ["bulk_reschedule"],
                            default: "bulk_reschedule",
                          },
                          intent: {
                            type: "string",
                            description:
                              'Natural-language request. Examples: "calendar today", "flights this week", "create meeting tomorrow 3pm".',
                          },
                          title: {
                            type: "string",
                            description:
                              "title TOP-LEVEL; NOT details. create_event needs title + details.start/end",
                          },
                          query: {
                            type: "string",
                            description:
                              "Search phrase for search_events/travel_itinerary: flight, dentist, Denver.",
                          },
                          queries: {
                            type: "array",
                            description:
                              "Optional search_events phrases array. Combined/deduped.",
                            items: { type: "string" },
                          },
                          details: {
                            type: "object",
                            description:
                              "details create|update|delete: calendarId,start/end,eventId,location; title/window TOP",
                            required: [],
                            properties: {
                              calendarId: { type: "string" },
                              timeMin: { type: "string" },
                              timeMax: { type: "string" },
                              timeZone: { type: "string" },
                              forceSync: { type: "boolean" },
                              windowDays: { type: "number" },
                              windowPreset: { type: "string" },
                              start: { type: "string" },
                              end: { type: "string" },
                              startAt: { type: "string" },
                              endAt: { type: "string" },
                              durationMinutes: { type: "number" },
                              eventId: { type: "string" },
                              newTitle: { type: "string" },
                              description: { type: "string" },
                              location: { type: "string" },
                              travelOriginAddress: { type: "string" },
                              attendees: {
                                type: "array",
                                items: { type: "string" },
                              },
                            },
                            additionalProperties: false,
                          },
                          durationMinutes: {
                            type: "number",
                            description:
                              "TOP-LEVEL flat. propose_times length minutes. Example: `{ subaction: 'propose_times', durationMinutes: 30, slotCount: 3, windowStart: '...', windowEnd: '...'...",
                          },
                          daysAhead: {
                            type: "number",
                            description:
                              "propose_times days ahead. Default 7. Ignored with windowStart/windowEnd.",
                          },
                          slotCount: {
                            type: "number",
                            description: "propose_times slot count. Default 3.",
                          },
                          windowStart: {
                            type: "string",
                            description:
                              "propose_times window earliest start. ISO-8601.",
                          },
                          windowEnd: {
                            type: "string",
                            description:
                              "propose_times window latest end. ISO-8601.",
                          },
                          startAt: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat. check_availability start. ISO-8601. Example: `{ subaction: 'check_availability', startAt: '2026-05-14T09:00:00Z', endAt...",
                          },
                          endAt: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat. check_availability end. ISO-8601. See `startAt`.",
                          },
                          timeZone: {
                            type: "string",
                            description:
                              "IANA timeZone for update_preferences hours.",
                          },
                          preferredStartLocal: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat for update_preferences. Earliest start local HH:MM 24h. Example: `{ subaction: 'update_preferences', preferredStartLocal: '09:00'...",
                          },
                          preferredEndLocal: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat for update_preferences. Latest end local HH:MM 24h. See `preferredStartLocal`.",
                          },
                          defaultDurationMinutes: {
                            type: "number",
                            description: "Default duration minutes (5-480).",
                          },
                          travelBufferMinutes: {
                            type: "number",
                            description:
                              "Buffer minutes before/after meetings (0-240).",
                          },
                          blackoutWindows: {
                            type: "array",
                            description:
                              "blackoutWindows[]: label startLocal HH:MM endLocal HH:MM daysOfWeek?[0..6]",
                            items: {
                              type: "object",
                              required: ["label", "startLocal", "endLocal"],
                              properties: {
                                label: { type: "string" },
                                startLocal: {
                                  type: "string",
                                  pattern: "^[0-2][0-9]:[0-5][0-9]$",
                                },
                                endLocal: {
                                  type: "string",
                                  pattern: "^[0-2][0-9]:[0-5][0-9]$",
                                },
                                daysOfWeek: {
                                  type: "array",
                                  items: {
                                    type: "number",
                                    minimum: 0,
                                    maximum: 6,
                                  },
                                },
                              },
                              additionalProperties: false,
                            },
                          },
                        },
                        additionalProperties: false,
                      },
                      CALENDAR_CHECK_AVAILABILITY: {
                        type: "object",
                        required: [],
                        properties: {
                          action: {
                            type: "string",
                            description:
                              'Subaction discriminator (auto-set to "check_availability" for this virtual. do not change).',
                            enum: ["check_availability"],
                            default: "check_availability",
                          },
                          intent: {
                            type: "string",
                            description:
                              'Natural-language request. Examples: "calendar today", "flights this week", "create meeting tomorrow 3pm".',
                          },
                          title: {
                            type: "string",
                            description:
                              "title TOP-LEVEL; NOT details. create_event needs title + details.start/end",
                          },
                          query: {
                            type: "string",
                            description:
                              "Search phrase for search_events/travel_itinerary: flight, dentist, Denver.",
                          },
                          queries: {
                            type: "array",
                            description:
                              "Optional search_events phrases array. Combined/deduped.",
                            items: { type: "string" },
                          },
                          details: {
                            type: "object",
                            description:
                              "details create|update|delete: calendarId,start/end,eventId,location; title/window TOP",
                            required: [],
                            properties: {
                              calendarId: { type: "string" },
                              timeMin: { type: "string" },
                              timeMax: { type: "string" },
                              timeZone: { type: "string" },
                              forceSync: { type: "boolean" },
                              windowDays: { type: "number" },
                              windowPreset: { type: "string" },
                              start: { type: "string" },
                              end: { type: "string" },
                              startAt: { type: "string" },
                              endAt: { type: "string" },
                              durationMinutes: { type: "number" },
                              eventId: { type: "string" },
                              newTitle: { type: "string" },
                              description: { type: "string" },
                              location: { type: "string" },
                              travelOriginAddress: { type: "string" },
                              attendees: {
                                type: "array",
                                items: { type: "string" },
                              },
                            },
                            additionalProperties: false,
                          },
                          durationMinutes: {
                            type: "number",
                            description:
                              "TOP-LEVEL flat. propose_times length minutes. Example: `{ subaction: 'propose_times', durationMinutes: 30, slotCount: 3, windowStart: '...', windowEnd: '...'...",
                          },
                          daysAhead: {
                            type: "number",
                            description:
                              "propose_times days ahead. Default 7. Ignored with windowStart/windowEnd.",
                          },
                          slotCount: {
                            type: "number",
                            description: "propose_times slot count. Default 3.",
                          },
                          windowStart: {
                            type: "string",
                            description:
                              "propose_times window earliest start. ISO-8601.",
                          },
                          windowEnd: {
                            type: "string",
                            description:
                              "propose_times window latest end. ISO-8601.",
                          },
                          startAt: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat. check_availability start. ISO-8601. Example: `{ subaction: 'check_availability', startAt: '2026-05-14T09:00:00Z', endAt...",
                          },
                          endAt: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat. check_availability end. ISO-8601. See `startAt`.",
                          },
                          timeZone: {
                            type: "string",
                            description:
                              "IANA timeZone for update_preferences hours.",
                          },
                          preferredStartLocal: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat for update_preferences. Earliest start local HH:MM 24h. Example: `{ subaction: 'update_preferences', preferredStartLocal: '09:00'...",
                          },
                          preferredEndLocal: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat for update_preferences. Latest end local HH:MM 24h. See `preferredStartLocal`.",
                          },
                          defaultDurationMinutes: {
                            type: "number",
                            description: "Default duration minutes (5-480).",
                          },
                          travelBufferMinutes: {
                            type: "number",
                            description:
                              "Buffer minutes before/after meetings (0-240).",
                          },
                          blackoutWindows: {
                            type: "array",
                            description:
                              "blackoutWindows[]: label startLocal HH:MM endLocal HH:MM daysOfWeek?[0..6]",
                            items: {
                              type: "object",
                              required: ["label", "startLocal", "endLocal"],
                              properties: {
                                label: { type: "string" },
                                startLocal: {
                                  type: "string",
                                  pattern: "^[0-2][0-9]:[0-5][0-9]$",
                                },
                                endLocal: {
                                  type: "string",
                                  pattern: "^[0-2][0-9]:[0-5][0-9]$",
                                },
                                daysOfWeek: {
                                  type: "array",
                                  items: {
                                    type: "number",
                                    minimum: 0,
                                    maximum: 6,
                                  },
                                },
                              },
                              additionalProperties: false,
                            },
                          },
                        },
                        additionalProperties: false,
                      },
                      CALENDAR_PROPOSE_TIMES: {
                        type: "object",
                        required: [],
                        properties: {
                          action: {
                            type: "string",
                            description:
                              'Subaction discriminator (auto-set to "propose_times" for this virtual. do not change).',
                            enum: ["propose_times"],
                            default: "propose_times",
                          },
                          intent: {
                            type: "string",
                            description:
                              'Natural-language request. Examples: "calendar today", "flights this week", "create meeting tomorrow 3pm".',
                          },
                          title: {
                            type: "string",
                            description:
                              "title TOP-LEVEL; NOT details. create_event needs title + details.start/end",
                          },
                          query: {
                            type: "string",
                            description:
                              "Search phrase for search_events/travel_itinerary: flight, dentist, Denver.",
                          },
                          queries: {
                            type: "array",
                            description:
                              "Optional search_events phrases array. Combined/deduped.",
                            items: { type: "string" },
                          },
                          details: {
                            type: "object",
                            description:
                              "details create|update|delete: calendarId,start/end,eventId,location; title/window TOP",
                            required: [],
                            properties: {
                              calendarId: { type: "string" },
                              timeMin: { type: "string" },
                              timeMax: { type: "string" },
                              timeZone: { type: "string" },
                              forceSync: { type: "boolean" },
                              windowDays: { type: "number" },
                              windowPreset: { type: "string" },
                              start: { type: "string" },
                              end: { type: "string" },
                              startAt: { type: "string" },
                              endAt: { type: "string" },
                              durationMinutes: { type: "number" },
                              eventId: { type: "string" },
                              newTitle: { type: "string" },
                              description: { type: "string" },
                              location: { type: "string" },
                              travelOriginAddress: { type: "string" },
                              attendees: {
                                type: "array",
                                items: { type: "string" },
                              },
                            },
                            additionalProperties: false,
                          },
                          durationMinutes: {
                            type: "number",
                            description:
                              "TOP-LEVEL flat. propose_times length minutes. Example: `{ subaction: 'propose_times', durationMinutes: 30, slotCount: 3, windowStart: '...', windowEnd: '...'...",
                          },
                          daysAhead: {
                            type: "number",
                            description:
                              "propose_times days ahead. Default 7. Ignored with windowStart/windowEnd.",
                          },
                          slotCount: {
                            type: "number",
                            description: "propose_times slot count. Default 3.",
                          },
                          windowStart: {
                            type: "string",
                            description:
                              "propose_times window earliest start. ISO-8601.",
                          },
                          windowEnd: {
                            type: "string",
                            description:
                              "propose_times window latest end. ISO-8601.",
                          },
                          startAt: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat. check_availability start. ISO-8601. Example: `{ subaction: 'check_availability', startAt: '2026-05-14T09:00:00Z', endAt...",
                          },
                          endAt: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat. check_availability end. ISO-8601. See `startAt`.",
                          },
                          timeZone: {
                            type: "string",
                            description:
                              "IANA timeZone for update_preferences hours.",
                          },
                          preferredStartLocal: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat for update_preferences. Earliest start local HH:MM 24h. Example: `{ subaction: 'update_preferences', preferredStartLocal: '09:00'...",
                          },
                          preferredEndLocal: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat for update_preferences. Latest end local HH:MM 24h. See `preferredStartLocal`.",
                          },
                          defaultDurationMinutes: {
                            type: "number",
                            description: "Default duration minutes (5-480).",
                          },
                          travelBufferMinutes: {
                            type: "number",
                            description:
                              "Buffer minutes before/after meetings (0-240).",
                          },
                          blackoutWindows: {
                            type: "array",
                            description:
                              "blackoutWindows[]: label startLocal HH:MM endLocal HH:MM daysOfWeek?[0..6]",
                            items: {
                              type: "object",
                              required: ["label", "startLocal", "endLocal"],
                              properties: {
                                label: { type: "string" },
                                startLocal: {
                                  type: "string",
                                  pattern: "^[0-2][0-9]:[0-5][0-9]$",
                                },
                                endLocal: {
                                  type: "string",
                                  pattern: "^[0-2][0-9]:[0-5][0-9]$",
                                },
                                daysOfWeek: {
                                  type: "array",
                                  items: {
                                    type: "number",
                                    minimum: 0,
                                    maximum: 6,
                                  },
                                },
                              },
                              additionalProperties: false,
                            },
                          },
                        },
                        additionalProperties: false,
                      },
                      CALENDAR_UPDATE_PREFERENCES: {
                        type: "object",
                        required: [],
                        properties: {
                          action: {
                            type: "string",
                            description:
                              'Subaction discriminator (auto-set to "update_preferences" for this virtual. do not change).',
                            enum: ["update_preferences"],
                            default: "update_preferences",
                          },
                          intent: {
                            type: "string",
                            description:
                              'Natural-language request. Examples: "calendar today", "flights this week", "create meeting tomorrow 3pm".',
                          },
                          title: {
                            type: "string",
                            description:
                              "title TOP-LEVEL; NOT details. create_event needs title + details.start/end",
                          },
                          query: {
                            type: "string",
                            description:
                              "Search phrase for search_events/travel_itinerary: flight, dentist, Denver.",
                          },
                          queries: {
                            type: "array",
                            description:
                              "Optional search_events phrases array. Combined/deduped.",
                            items: { type: "string" },
                          },
                          details: {
                            type: "object",
                            description:
                              "details create|update|delete: calendarId,start/end,eventId,location; title/window TOP",
                            required: [],
                            properties: {
                              calendarId: { type: "string" },
                              timeMin: { type: "string" },
                              timeMax: { type: "string" },
                              timeZone: { type: "string" },
                              forceSync: { type: "boolean" },
                              windowDays: { type: "number" },
                              windowPreset: { type: "string" },
                              start: { type: "string" },
                              end: { type: "string" },
                              startAt: { type: "string" },
                              endAt: { type: "string" },
                              durationMinutes: { type: "number" },
                              eventId: { type: "string" },
                              newTitle: { type: "string" },
                              description: { type: "string" },
                              location: { type: "string" },
                              travelOriginAddress: { type: "string" },
                              attendees: {
                                type: "array",
                                items: { type: "string" },
                              },
                            },
                            additionalProperties: false,
                          },
                          durationMinutes: {
                            type: "number",
                            description:
                              "TOP-LEVEL flat. propose_times length minutes. Example: `{ subaction: 'propose_times', durationMinutes: 30, slotCount: 3, windowStart: '...', windowEnd: '...'...",
                          },
                          daysAhead: {
                            type: "number",
                            description:
                              "propose_times days ahead. Default 7. Ignored with windowStart/windowEnd.",
                          },
                          slotCount: {
                            type: "number",
                            description: "propose_times slot count. Default 3.",
                          },
                          windowStart: {
                            type: "string",
                            description:
                              "propose_times window earliest start. ISO-8601.",
                          },
                          windowEnd: {
                            type: "string",
                            description:
                              "propose_times window latest end. ISO-8601.",
                          },
                          startAt: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat. check_availability start. ISO-8601. Example: `{ subaction: 'check_availability', startAt: '2026-05-14T09:00:00Z', endAt...",
                          },
                          endAt: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat. check_availability end. ISO-8601. See `startAt`.",
                          },
                          timeZone: {
                            type: "string",
                            description:
                              "IANA timeZone for update_preferences hours.",
                          },
                          preferredStartLocal: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat for update_preferences. Earliest start local HH:MM 24h. Example: `{ subaction: 'update_preferences', preferredStartLocal: '09:00'...",
                          },
                          preferredEndLocal: {
                            type: "string",
                            description:
                              "TOP-LEVEL flat for update_preferences. Latest end local HH:MM 24h. See `preferredStartLocal`.",
                          },
                          defaultDurationMinutes: {
                            type: "number",
                            description: "Default duration minutes (5-480).",
                          },
                          travelBufferMinutes: {
                            type: "number",
                            description:
                              "Buffer minutes before/after meetings (0-240).",
                          },
                          blackoutWindows: {
                            type: "array",
                            description:
                              "blackoutWindows[]: label startLocal HH:MM endLocal HH:MM daysOfWeek?[0..6]",
                            items: {
                              type: "object",
                              required: ["label", "startLocal", "endLocal"],
                              properties: {
                                label: { type: "string" },
                                startLocal: {
                                  type: "string",
                                  pattern: "^[0-2][0-9]:[0-5][0-9]$",
                                },
                                endLocal: {
                                  type: "string",
                                  pattern: "^[0-2][0-9]:[0-5][0-9]$",
                                },
                                daysOfWeek: {
                                  type: "array",
                                  items: {
                                    type: "number",
                                    minimum: 0,
                                    maximum: 6,
                                  },
                                },
                              },
                              additionalProperties: false,
                            },
                          },
                        },
                        additionalProperties: false,
                      },
                      RESOLVE_REQUEST: {
                        type: "object",
                        required: [],
                        properties: {
                          action: {
                            type: "string",
                            description: "approve | reject.",
                            enum: ["approve", "reject"],
                          },
                          requestId: {
                            type: "string",
                            description:
                              "Approval request id. Optional when user references pending request.",
                          },
                          reason: {
                            type: "string",
                            description:
                              "Optional approve/reject reason, user language.",
                          },
                        },
                        additionalProperties: false,
                      },
                      RESOLVE_REQUEST_APPROVE: {
                        type: "object",
                        required: [],
                        properties: {
                          action: {
                            type: "string",
                            description:
                              'Subaction discriminator (auto-set to "approve" for this virtual. do not change).',
                            enum: ["approve"],
                            default: "approve",
                          },
                          requestId: {
                            type: "string",
                            description:
                              "Approval request id. Optional when user references pending request.",
                          },
                          reason: {
                            type: "string",
                            description:
                              "Optional approve/reject reason, user language.",
                          },
                        },
                        additionalProperties: false,
                      },
                      RESOLVE_REQUEST_REJECT: {
                        type: "object",
                        required: [],
                        properties: {
                          action: {
                            type: "string",
                            description:
                              'Subaction discriminator (auto-set to "reject" for this virtual. do not change).',
                            enum: ["reject"],
                            default: "reject",
                          },
                          requestId: {
                            type: "string",
                            description:
                              "Approval request id. Optional when user references pending request.",
                          },
                          reason: {
                            type: "string",
                            description:
                              "Optional approve/reject reason, user language.",
                          },
                        },
                        additionalProperties: false,
                      },
                      OWNER_ALARMS: {
                        type: "object",
                        required: [],
                        properties: {
                          action: {
                            type: "string",
                            description:
                              "Owner item op: create|update|delete|complete|skip|snooze|review.",
                            enum: [
                              "create",
                              "update",
                              "delete",
                              "complete",
                              "skip",
                              "snooze",
                              "review",
                            ],
                          },
                          kind: {
                            type: "string",
                            description: "Optional backing kind override.",
                            enum: ["definition", "goal"],
                          },
                          intent: {
                            type: "string",
                            description: "Free-form owner request.",
                          },
                          title: {
                            type: "string",
                            description: "Item title when known.",
                          },
                          target: {
                            type: "string",
                            description:
                              "Existing item id/title for update/delete/complete/skip/snooze/review.",
                          },
                          minutes: {
                            type: "number",
                            description: "Snooze minutes when action=snooze.",
                          },
                          details: {
                            type: "object",
                            description:
                              "Structured schedule/cadence/notes/details.",
                            required: [],
                            properties: {},
                            additionalProperties: true,
                          },
                        },
                        additionalProperties: false,
                      },
                      OWNER_HEALTH_TODAY: {
                        type: "object",
                        required: [],
                        properties: {
                          action: {
                            type: "string",
                            description:
                              'Subaction discriminator (auto-set to "today" for this virtual. do not change).',
                            enum: ["today"],
                            default: "today",
                          },
                          intent: {
                            type: "string",
                            description: "free-form intent infer subaction",
                          },
                          metric: {
                            type: "string",
                            description:
                              "by_metric: steps|heart_rate|sleep_hours|calories|distance_meters|active_minutes (e.g. steps, sleep_hours, heart_rate)",
                            enum: [
                              "steps",
                              "heart_rate",
                              "sleep_hours",
                              "calories",
                              "distance_meters",
                              "active_minutes",
                            ],
                          },
                          date: {
                            type: "string",
                            description:
                              "YYYY-MM-DD single-day (e.g. 2026-05-10)",
                          },
                          days: {
                            type: "number",
                            description:
                              "window days trend|by_metric (e.g. 1, 7, 30)",
                            minimum: 1,
                            maximum: 365,
                          },
                        },
                        additionalProperties: false,
                      },
                      OWNER_HEALTH_BY_METRIC: {
                        type: "object",
                        required: [],
                        properties: {
                          action: {
                            type: "string",
                            description:
                              'Subaction discriminator (auto-set to "by_metric" for this virtual. do not change).',
                            enum: ["by_metric"],
                            default: "by_metric",
                          },
                          intent: {
                            type: "string",
                            description: "free-form intent infer subaction",
                          },
                          metric: {
                            type: "string",
                            description:
                              "by_metric: steps|heart_rate|sleep_hours|calories|distance_meters|active_minutes (e.g. steps, sleep_hours, heart_rate)",
                            enum: [
                              "steps",
                              "heart_rate",
                              "sleep_hours",
                              "calories",
                              "distance_meters",
                              "active_minutes",
                            ],
                          },
                          date: {
                            type: "string",
                            description:
                              "YYYY-MM-DD single-day (e.g. 2026-05-10)",
                          },
                          days: {
                            type: "number",
                            description:
                              "window days trend|by_metric (e.g. 1, 7, 30)",
                            minimum: 1,
                            maximum: 365,
                          },
                        },
                        additionalProperties: false,
                      },
                      OWNER_HEALTH_STATUS: {
                        type: "object",
                        required: [],
                        properties: {
                          action: {
                            type: "string",
                            description:
                              'Subaction discriminator (auto-set to "status" for this virtual. do not change).',
                            enum: ["status"],
                            default: "status",
                          },
                          intent: {
                            type: "string",
                            description: "free-form intent infer subaction",
                          },
                          metric: {
                            type: "string",
                            description:
                              "by_metric: steps|heart_rate|sleep_hours|calories|distance_meters|active_minutes (e.g. steps, sleep_hours, heart_rate)",
                            enum: [
                              "steps",
                              "heart_rate",
                              "sleep_hours",
                              "calories",
                              "distance_meters",
                              "active_minutes",
                            ],
                          },
                          date: {
                            type: "string",
                            description:
                              "YYYY-MM-DD single-day (e.g. 2026-05-10)",
                          },
                          days: {
                            type: "number",
                            description:
                              "window days trend|by_metric (e.g. 1, 7, 30)",
                            minimum: 1,
                            maximum: 365,
                          },
                        },
                        additionalProperties: false,
                      },
                      OWNER_SCREENTIME_SUMMARY: {
                        type: "object",
                        required: [],
                        properties: {
                          action: {
                            type: "string",
                            description:
                              'Subaction discriminator (auto-set to "summary" for this virtual. do not change).',
                            enum: ["summary"],
                            default: "summary",
                          },
                          source: {
                            type: "string",
                            description: "source filter: app|website",
                            enum: ["app", "website"],
                          },
                          identifier: {
                            type: "string",
                            description:
                              "Specific app bundle id or website domain when filtering screen-time to one source.",
                          },
                          date: {
                            type: "string",
                            description: "YYYY-MM-DD for the today subaction.",
                          },
                          days: {
                            type: "number",
                            description:
                              "Number of days back from now for weekly/weekly_average_by_app windows.",
                          },
                          limit: {
                            type: "number",
                            description:
                              "Top-N for by_app/by_website/browser_activity (default 10).",
                          },
                          windowDays: {
                            type: "number",
                            description:
                              "Window in days for by_app/by_website summary queries.",
                          },
                          windowHours: {
                            type: "number",
                            description:
                              "Window in hours for activity_report/time_on_app/time_on_site (default 24, max 720).",
                          },
                          appNameOrBundleId: {
                            type: "string",
                            description:
                              "App name (e. g. 'Safari') or bundle id (e. g. 'com. apple. Safari') for time_on_app.",
                          },
                          domain: {
                            type: "string",
                            description:
                              "Hostname (e. g. 'github. com') for time_on_site.",
                          },
                          deviceId: {
                            type: "string",
                            description:
                              "Filter browser_activity to one registered device id. omit for default.",
                          },
                        },
                        additionalProperties: false,
                      },
                      OWNER_SCREENTIME_TODAY: {
                        type: "object",
                        required: [],
                        properties: {
                          action: {
                            type: "string",
                            description:
                              'Subaction discriminator (auto-set to "today" for this virtual. do not change).',
                            enum: ["today"],
                            default: "today",
                          },
                          source: {
                            type: "string",
                            description: "source filter: app|website",
                            enum: ["app", "website"],
                          },
                          identifier: {
                            type: "string",
                            description:
                              "Specific app bundle id or website domain when filtering screen-time to one source.",
                          },
                          date: {
                            type: "string",
                            description: "YYYY-MM-DD for the today subaction.",
                          },
                          days: {
                            type: "number",
                            description:
                              "Number of days back from now for weekly/weekly_average_by_app windows.",
                          },
                          limit: {
                            type: "number",
                            description:
                              "Top-N for by_app/by_website/browser_activity (default 10).",
                          },
                          windowDays: {
                            type: "number",
                            description:
                              "Window in days for by_app/by_website summary queries.",
                          },
                          windowHours: {
                            type: "number",
                            description:
                              "Window in hours for activity_report/time_on_app/time_on_site (default 24, max 720).",
                          },
                          appNameOrBundleId: {
                            type: "string",
                            description:
                              "App name (e. g. 'Safari') or bundle id (e. g. 'com. apple. Safari') for time_on_app.",
                          },
                          domain: {
                            type: "string",
                            description:
                              "Hostname (e. g. 'github. com') for time_on_site.",
                          },
                          deviceId: {
                            type: "string",
                            description:
                              "Filter browser_activity to one registered device id. omit for default.",
                          },
                        },
                        additionalProperties: false,
                      },
                      OWNER_SCREENTIME_WEEKLY: {
                        type: "object",
                        required: [],
                        properties: {
                          action: {
                            type: "string",
                            description:
                              'Subaction discriminator (auto-set to "weekly" for this virtual. do not change).',
                            enum: ["weekly"],
                            default: "weekly",
                          },
                          source: {
                            type: "string",
                            description: "source filter: app|website",
                            enum: ["app", "website"],
                          },
                          identifier: {
                            type: "string",
                            description:
                              "Specific app bundle id or website domain when filtering screen-time to one source.",
                          },
                          date: {
                            type: "string",
                            description: "YYYY-MM-DD for the today subaction.",
                          },
                          days: {
                            type: "number",
                            description:
                              "Number of days back from now for weekly/weekly_average_by_app windows.",
                          },
                          limit: {
                            type: "number",
                            description:
                              "Top-N for by_app/by_website/browser_activity (default 10).",
                          },
                          windowDays: {
                            type: "number",
                            description:
                              "Window in days for by_app/by_website summary queries.",
                          },
                          windowHours: {
                            type: "number",
                            description:
                              "Window in hours for activity_report/time_on_app/time_on_site (default 24, max 720).",
                          },
                          appNameOrBundleId: {
                            type: "string",
                            description:
                              "App name (e. g. 'Safari') or bundle id (e. g. 'com. apple. Safari') for time_on_app.",
                          },
                          domain: {
                            type: "string",
                            description:
                              "Hostname (e. g. 'github. com') for time_on_site.",
                          },
                          deviceId: {
                            type: "string",
                            description:
                              "Filter browser_activity to one registered device id. omit for default.",
                          },
                        },
                        additionalProperties: false,
                      },
                      OWNER_SCREENTIME_BY_APP: {
                        type: "object",
                        required: [],
                        properties: {
                          action: {
                            type: "string",
                            description:
                              'Subaction discriminator (auto-set to "by_app" for this virtual. do not change).',
                            enum: ["by_app"],
                            default: "by_app",
                          },
                          source: {
                            type: "string",
                            description: "source filter: app|website",
                            enum: ["app", "website"],
                          },
                          identifier: {
                            type: "string",
                            description:
                              "Specific app bundle id or website domain when filtering screen-time to one source.",
                          },
                          date: {
                            type: "string",
                            description: "YYYY-MM-DD for the today subaction.",
                          },
                          days: {
                            type: "number",
                            description:
                              "Number of days back from now for weekly/weekly_average_by_app windows.",
                          },
                          limit: {
                            type: "number",
                            description:
                              "Top-N for by_app/by_website/browser_activity (default 10).",
                          },
                          windowDays: {
                            type: "number",
                            description:
                              "Window in days for by_app/by_website summary queries.",
                          },
                          windowHours: {
                            type: "number",
                            description:
                              "Window in hours for activity_report/time_on_app/time_on_site (default 24, max 720).",
                          },
                          appNameOrBundleId: {
                            type: "string",
                            description:
                              "App name (e. g. 'Safari') or bundle id (e. g. 'com. apple. Safari') for time_on_app.",
                          },
                          domain: {
                            type: "string",
                            description:
                              "Hostname (e. g. 'github. com') for time_on_site.",
                          },
                          deviceId: {
                            type: "string",
                            description:
                              "Filter browser_activity to one registered device id. omit for default.",
                          },
                        },
                        additionalProperties: false,
                      },
                      OWNER_SCREENTIME_BY_WEBSITE: {
                        type: "object",
                        required: [],
                        properties: {
                          action: {
                            type: "string",
                            description:
                              'Subaction discriminator (auto-set to "by_website" for this virtual. do not change).',
                            enum: ["by_website"],
                            default: "by_website",
                          },
                          source: {
                            type: "string",
                            description: "source filter: app|website",
                            enum: ["app", "website"],
                          },
                          identifier: {
                            type: "string",
                            description:
                              "Specific app bundle id or website domain when filtering screen-time to one source.",
                          },
                          date: {
                            type: "string",
                            description: "YYYY-MM-DD for the today subaction.",
                          },
                          days: {
                            type: "number",
                            description:
                              "Number of days back from now for weekly/weekly_average_by_app windows.",
                          },
                          limit: {
                            type: "number",
                            description:
                              "Top-N for by_app/by_website/browser_activity (default 10).",
                          },
                          windowDays: {
                            type: "number",
                            description:
                              "Window in days for by_app/by_website summary queries.",
                          },
                          windowHours: {
                            type: "number",
                            description:
                              "Window in hours for activity_report/time_on_app/time_on_site (default 24, max 720).",
                          },
                          appNameOrBundleId: {
                            type: "string",
                            description:
                              "App name (e. g. 'Safari') or bundle id (e. g. 'com. apple. Safari') for time_on_app.",
                          },
                          domain: {
                            type: "string",
                            description:
                              "Hostname (e. g. 'github. com') for time_on_site.",
                          },
                          deviceId: {
                            type: "string",
                            description:
                              "Filter browser_activity to one registered device id. omit for default.",
                          },
                        },
                        additionalProperties: false,
                      },
                      OWNER_SCREENTIME_ACTIVITY_REPORT: {
                        type: "object",
                        required: [],
                        properties: {
                          action: {
                            type: "string",
                            description:
                              'Subaction discriminator (auto-set to "activity_report" for this virtual. do not change).',
                            enum: ["activity_report"],
                            default: "activity_report",
                          },
                          source: {
                            type: "string",
                            description: "source filter: app|website",
                            enum: ["app", "website"],
                          },
                          identifier: {
                            type: "string",
                            description:
                              "Specific app bundle id or website domain when filtering screen-time to one source.",
                          },
                          date: {
                            type: "string",
                            description: "YYYY-MM-DD for the today subaction.",
                          },
                          days: {
                            type: "number",
                            description:
                              "Number of days back from now for weekly/weekly_average_by_app windows.",
                          },
                          limit: {
                            type: "number",
                            description:
                              "Top-N for by_app/by_website/browser_activity (default 10).",
                          },
                          windowDays: {
                            type: "number",
                            description:
                              "Window in days for by_app/by_website summary queries.",
                          },
                          windowHours: {
                            type: "number",
                            description:
                              "Window in hours for activity_report/time_on_app/time_on_site (default 24, max 720).",
                          },
                          appNameOrBundleId: {
                            type: "string",
                            description:
                              "App name (e. g. 'Safari') or bundle id (e. g. 'com. apple. Safari') for time_on_app.",
                          },
                          domain: {
                            type: "string",
                            description:
                              "Hostname (e. g. 'github. com') for time_on_site.",
                          },
                          deviceId: {
                            type: "string",
                            description:
                              "Filter browser_activity to one registered device id. omit for default.",
                          },
                        },
                        additionalProperties: false,
                      },
                      OWNER_SCREENTIME_BROWSER_ACTIVITY: {
                        type: "object",
                        required: [],
                        properties: {
                          action: {
                            type: "string",
                            description:
                              'Subaction discriminator (auto-set to "browser_activity" for this virtual. do not change).',
                            enum: ["browser_activity"],
                            default: "browser_activity",
                          },
                          source: {
                            type: "string",
                            description: "source filter: app|website",
                            enum: ["app", "website"],
                          },
                          identifier: {
                            type: "string",
                            description:
                              "Specific app bundle id or website domain when filtering screen-time to one source.",
                          },
                          date: {
                            type: "string",
                            description: "YYYY-MM-DD for the today subaction.",
                          },
                          days: {
                            type: "number",
                            description:
                              "Number of days back from now for weekly/weekly_average_by_app windows.",
                          },
                          limit: {
                            type: "number",
                            description:
                              "Top-N for by_app/by_website/browser_activity (default 10).",
                          },
                          windowDays: {
                            type: "number",
                            description:
                              "Window in days for by_app/by_website summary queries.",
                          },
                          windowHours: {
                            type: "number",
                            description:
                              "Window in hours for activity_report/time_on_app/time_on_site (default 24, max 720).",
                          },
                          appNameOrBundleId: {
                            type: "string",
                            description:
                              "App name (e. g. 'Safari') or bundle id (e. g. 'com. apple. Safari') for time_on_app.",
                          },
                          domain: {
                            type: "string",
                            description:
                              "Hostname (e. g. 'github. com') for time_on_site.",
                          },
                          deviceId: {
                            type: "string",
                            description:
                              "Filter browser_activity to one registered device id. omit for default.",
                          },
                        },
                        additionalProperties: false,
                      },
                    },
                    guidedDecode: true,
                  },
                  cerebras: {
                    promptCacheKey:
                      "v5:e2e7887ce94ac9ea5c3b655dc0277a7bf71be3bcde0c0a3475f6e49c87e33fd6",
                    prompt_cache_key:
                      "v5:e2e7887ce94ac9ea5c3b655dc0277a7bf71be3bcde0c0a3475f6e49c87e33fd6",
                  },
                  openai: {
                    promptCacheKey:
                      "v5:e2e7887ce94ac9ea5c3b655dc0277a7bf71be3bcde0c0a3475f6e49c87e33fd6",
                  },
                  openrouter: {
                    promptCacheKey:
                      "v5:e2e7887ce94ac9ea5c3b655dc0277a7bf71be3bcde0c0a3475f6e49c87e33fd6",
                    prompt_cache_key:
                      "v5:e2e7887ce94ac9ea5c3b655dc0277a7bf71be3bcde0c0a3475f6e49c87e33fd6",
                  },
                  gateway: { caching: "auto" },
                  anthropic: {
                    cacheControl: { type: "ephemeral" },
                    cacheSystem: true,
                    maxBreakpoints: 4,
                    cacheBreakpoints: [
                      {
                        segmentIndex: 2,
                        segmentHash:
                          "850b4e10742c64b6d83be119a7da6f24f0d13b5a28dfec6188abcbf8e44ddf35",
                        ttl: "short",
                        cacheControl: { type: "ephemeral" },
                      },
                      {
                        segmentIndex: 9,
                        segmentHash:
                          "77fafa9d8490011762b2efa49f96d0958bbfbc41849d9ffdfa7f69c78a838892",
                        ttl: "short",
                        cacheControl: { type: "ephemeral" },
                      },
                      {
                        segmentIndex: 16,
                        segmentHash:
                          "49402a30104ff0942ad95a2ec4a827f970fceed11193f78510d66cffd07a9af4",
                        ttl: "short",
                        cacheControl: { type: "ephemeral" },
                      },
                    ],
                  },
                },
                response: "",
                toolCalls: [],
                costUsd: 0,
                priceTableId: "eliza-v1-2026-05-11",
              },
              cache: {
                segmentHashes: [
                  "ab8cf1343ace051ce69c596cc87708fd3426291ebcbcd4039f0994601b7d3612",
                  "70d7d443951dd9c6ccfeb1cca3d1e2330f54ae693f4439069bb1f625fbb45c18",
                  "850b4e10742c64b6d83be119a7da6f24f0d13b5a28dfec6188abcbf8e44ddf35",
                  "29f6bddfaa8e7a543be8b60f577e1e97a3cf72e718261dda93940a3c0510c66c",
                  "0d89bd99f9cc76fba69bf8ea9eb426ba207a7a03eecbd1ddea8894dffb480948",
                  "512e88459fcbc7e6e73f6bd9d25711273ab983fba796ef0cb1cbc89e75f04785",
                  "8c53e8428f25f5ccc23d314108d913ea9262e5b9b7ac69d885dead0c6bfd0ef0",
                  "eeda671967c7cf431f8dadcd31196c97a0c94db1b024d02fde63e9045abc030a",
                  "a4a3da64b798cd6fe913b6d2d4df8511586a11229698b7fa25a5c273e4739547",
                  "77fafa9d8490011762b2efa49f96d0958bbfbc41849d9ffdfa7f69c78a838892",
                  "7860c3dedaf4d098a19b41075ab83435c9fcd6ea1ec64728a585660a0b397bdd",
                  "fb0e3cf357f52eed7c29249aada0465a4ee72b30875b8c30bb147d266ca044f1",
                  "cd32700428001eaefd419bb21332eccba9ae7fdb7a4728bce8c7363f676c1d70",
                  "1f84135839fc4d7831a7a3ffa8bf6d86b3646685f4c5698ba24d023fabcf2b8f",
                  "2b7ec29c6e1d333c0b41439db3c58273cef2397d94ce87912456c5a863a7d877",
                  "b7029279b0c09707be870197b54b40b42a734d842976e2b769753dc5dd188474",
                  "49402a30104ff0942ad95a2ec4a827f970fceed11193f78510d66cffd07a9af4",
                ],
                prefixHash:
                  "e2e7887ce94ac9ea5c3b655dc0277a7bf71be3bcde0c0a3475f6e49c87e33fd6",
              },
            },
          ],
          metrics: {
            totalLatencyMs: 192,
            totalPromptTokens: 0,
            totalCompletionTokens: 0,
            totalCacheReadTokens: 0,
            totalCacheCreationTokens: 0,
            totalCostUsd: 0,
            plannerIterations: 1,
            toolCallsExecuted: 0,
            toolCallFailures: 0,
            toolSearchCount: 1,
            evaluatorFailures: 0,
          },
          endedAt: 1782803125262,
        },
      },
    ],
    summaries: [
      {
        path: "trajectories/546ac3ab-0468-01a2-9d5b-52dfa34bf9cc/tj-58d2f3319ed89d.json",
        trajectoryId: "tj-58d2f3319ed89d",
        scenarioId: "backup.restore-recall",
        status: "finished",
        metrics: {
          totalLatencyMs: 192,
          totalPromptTokens: 0,
          totalCompletionTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
          totalCostUsd: 0,
          plannerIterations: 1,
          toolCallsExecuted: 0,
          toolCallFailures: 0,
          toolSearchCount: 1,
          evaluatorFailures: 0,
        },
        stages: [
          {
            index: 0,
            stageId: "stage-msghandler-1782803124979",
            kind: "messageHandler",
            latencyMs: 73,
            modelType: "RESPONSE_HANDLER",
            provider: "default",
            promptTokens: null,
            completionTokens: null,
            totalTokens: null,
            cacheReadTokens: null,
            cachePercent: null,
            costUsd: 0,
            cachePrefixHash:
              "28edcfd339548d655f8c9b8cd8c0ad28d12b1d2dd8feb2516aed6196d6b1277b",
            cacheSegmentCount: 8,
            toolInputPreview: "",
            toolOutputPreview: "",
            toolSearchQuery: "",
            toolSearchTopResults: [],
            responsePreview: "",
          },
          {
            index: 1,
            stageId: "stage-toolsearch-1782803125118",
            kind: "toolSearch",
            latencyMs: 89,
            promptTokens: null,
            completionTokens: null,
            totalTokens: null,
            cacheReadTokens: null,
            cachePercent: null,
            costUsd: null,
            cacheSegmentCount: null,
            toolInputPreview: "",
            toolOutputPreview: "",
            toolSearchQuery:
              "Before this restore, I gave you a backup recall phrase. What exact three-word phrase did I ask you to remember? Reply with only that phrase.",
            toolSearchTopResults: [
              {
                name: "REPLY",
                score: 1,
                rank: 0,
                matchedBy: ["keyword", "bm25", "contextMatch"],
              },
              {
                name: "CALENDAR",
                score: 1,
                rank: 1,
                matchedBy: ["keyword", "bm25", "contextMatch"],
              },
              {
                name: "RESOLVE_REQUEST",
                score: 1,
                rank: 2,
                matchedBy: ["keyword", "bm25", "contextMatch"],
              },
              {
                name: "IGNORE",
                score: 0.980437,
                rank: 3,
                matchedBy: ["keyword", "bm25", "contextMatch"],
              },
              {
                name: "NONE",
                score: 0.938812,
                rank: 4,
                matchedBy: ["keyword", "bm25", "contextMatch"],
              },
            ],
            responsePreview: "",
          },
          {
            index: 2,
            stageId: "stage-planner-iter-1-1782803125215",
            kind: "planner",
            iteration: 1,
            latencyMs: 30,
            modelType: "ACTION_PLANNER",
            provider: "default",
            promptTokens: null,
            completionTokens: null,
            totalTokens: null,
            cacheReadTokens: null,
            cachePercent: null,
            costUsd: 0,
            cachePrefixHash:
              "e2e7887ce94ac9ea5c3b655dc0277a7bf71be3bcde0c0a3475f6e49c87e33fd6",
            cacheSegmentCount: 17,
            toolInputPreview: "",
            toolOutputPreview: "",
            toolSearchQuery: "",
            toolSearchTopResults: [],
            responsePreview: "",
          },
        ],
      },
    ],
  },
  nativeExport: {
    manifest: {
      schema: "eliza_scenario_native_export",
      schemaVersion: 1,
      generatedAt: "2026-06-30T07:05:25.880Z",
      runDir:
        "/Users/shawwalters/.codex/worktrees/5612/eliza/.github/issue-evidence/9963-live-restore-run",
      trajectoriesDir:
        "/Users/shawwalters/.codex/worktrees/5612/eliza/.github/issue-evidence/9963-live-restore-run/trajectories",
      jsonlPath:
        "/Users/shawwalters/.codex/worktrees/5612/eliza/.github/issue-evidence/9963-live-restore-native.jsonl",
      manifestPath:
        "/Users/shawwalters/.codex/worktrees/5612/eliza/.github/issue-evidence/9963-live-restore-native.manifest.json",
      counts: {
        trajectoryFiles: 1,
        parsedTrajectories: 1,
        skippedFiles: 0,
        rows: 0,
        passedRows: 0,
        failedRows: 0,
        skippedScenarioRows: 0,
        unknownOutcomeRows: 0,
      },
      runIds: ["f39e297f-e254-4579-92c9-e8ae7a329865"],
      scenarioIds: ["backup.restore-recall"],
      agentIds: ["546ac3ab-0468-01a2-9d5b-52dfa34bf9cc"],
    },
    rows: [],
  },
};
