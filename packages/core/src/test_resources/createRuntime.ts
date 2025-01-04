import {
    SqliteDatabaseAdapter,
    loadVecExtensions,
} from "@elizaos/adapter-sqlite";
import { SqlJsDatabaseAdapter } from "@elizaos/adapter-sqljs";
import { SupabaseDatabaseAdapter } from "@elizaos/adapter-supabase";
import { DatabaseAdapter } from "../database.ts";
import { getEndpoint } from "../models.ts";
import { AgentRuntime } from "../runtime.ts";
import { Action, Evaluator, ModelProviderName, Provider } from "../types.ts";
import {
    SUPABASE_ANON_KEY,
    SUPABASE_URL,
    TEST_EMAIL,
    TEST_PASSWORD,
    zeroUuid,
} from "./constants.ts";
import { User } from "./types.ts";

/**
 * Creates a runtime environment for the agent.
 * 
 * @param {Object} param - The parameters for creating the runtime.
 * @param {Record<string, string> | NodeJS.ProcessEnv} [param.env] - The environment variables.
 * @param {number} [param.conversationLength] - The length of the conversation.
 * @param {Evaluator[]} [param.evaluators] - The evaluators to be used.
 * @param {Action[]} [param.actions] - The actions to be used.
 * @param {Provider[]} [param.providers] - The providers to be used.
 * @returns {Object} An object containing the created user, session, and runtime.
 */
export async function createRuntime({
    env,
    conversationLength,
    evaluators = [],
    actions = [],
    providers = [],
}: {
    env?: Record<string, string> | NodeJS.ProcessEnv;
    conversationLength?: number;
    evaluators?: Evaluator[];
    actions?: Action[];
    providers?: Provider[];
}) {
    let adapter: DatabaseAdapter;
    let user: User;
    let session: {
        user: User;
    };

    switch (env?.TEST_DATABASE_CLIENT as string) {
        case "sqljs":
            {
                const module = await import("sql.js");

                const initSqlJs = module.default;

                // SQLite adapter
                const SQL = await initSqlJs({});
                const db = new SQL.Database();

                adapter = new SqlJsDatabaseAdapter(db);

                // Load sqlite-vss
                loadVecExtensions((adapter as SqlJsDatabaseAdapter).db);
                // Create a test user and session
                session = {
                    user: {
                        id: zeroUuid,
                        email: "test@example.com",
                    },
                };
            }
            break;
        case "supabase": {
            const module = await import("@supabase/supabase-js");

            const { createClient } = module;

            const supabase = createClient(
                env?.SUPABASE_URL ?? SUPABASE_URL,
                env?.SUPABASE_SERVICE_API_KEY ?? SUPABASE_ANON_KEY
            );

            const { data } = await supabase.auth.signInWithPassword({
                email: TEST_EMAIL!,
                password: TEST_PASSWORD!,
            });

            user = data.user as User;
            session = data.session as unknown as { user: User };

            if (!session) {
                const response = await supabase.auth.signUp({
                    email: TEST_EMAIL!,
                    password: TEST_PASSWORD!,
                });

                // Change the name of the user
                const { error } = await supabase
                    .from("accounts")
                    .update({ name: "Test User" })
                    .eq("id", response.data.user?.id);

                if (error) {
                    throw new Error(
                        "Create runtime error: " + JSON.stringify(error)
                    );
                }

                user = response.data.user as User;
                session = response.data.session as unknown as { user: User };
            }

            adapter = new SupabaseDatabaseAdapter(
                env?.SUPABASE_URL ?? SUPABASE_URL,
                env?.SUPABASE_SERVICE_API_KEY ?? SUPABASE_ANON_KEY
            );
            break;
        }
        case "sqlite":
        default:
            {
                const module = await import("better-sqlite3");

                const Database = module.default;

                // SQLite adapter
                adapter = new SqliteDatabaseAdapter(new Database(":memory:"));

                // Load sqlite-vss
                await loadVecExtensions((adapter as SqliteDatabaseAdapter).db);
                // Create a test user and session
                session = {
                    user: {
                        id: zeroUuid,
                        email: "test@example.com",
                    },
                };
            }
            break;
    }

    const runtime = new AgentRuntime({
        serverUrl: getEndpoint(ModelProviderName.OPENAI),
        conversationLength,
        token: env!.OPENAI_API_KEY!,
        modelProvider: ModelProviderName.OPENAI,
        actions: actions ?? [],
        evaluators: evaluators ?? [],
        providers: providers ?? [],
        databaseAdapter: adapter,
    });

    return { user, session, runtime };
}
