export interface AdReportEnv {
  ADMOB_ACCOUNT_ID?: string;
  ADMOB_CLIENT_ID?: string;
  ADMOB_CLIENT_SECRET?: string;
  ADMOB_REFRESH_TOKEN?: string;
}

export interface AdReport {
  enabled: boolean;
  impressions: number;
  clicks: number;
  earnings: string;
  error: string;
}

type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export function adReportReady(env: AdReportEnv): boolean {
  return Boolean(
    env.ADMOB_ACCOUNT_ID &&
      env.ADMOB_CLIENT_ID &&
      env.ADMOB_CLIENT_SECRET &&
      env.ADMOB_REFRESH_TOKEN
  );
}

function day(date: Date): { year: number; month: number; day: number } {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/** Reads AdMob earnings when the owner has set the reporting secrets. Otherwise it stays off. */
export async function loadAdReport(
  env: AdReportEnv,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  now = new Date()
): Promise<AdReport> {
  if (!adReportReady(env)) {
    return { enabled: false, impressions: 0, clicks: 0, earnings: "0", error: "" };
  }
  const account = String(env.ADMOB_ACCOUNT_ID).replace(/^accounts\//, "");
  if (!/^pub-\d{16}$/.test(account)) {
    return {
      enabled: true,
      impressions: 0,
      clicks: 0,
      earnings: "0",
      error: "The AdMob account id is not valid.",
    };
  }
  try {
    const tokenResponse = await fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: String(env.ADMOB_CLIENT_ID),
        client_secret: String(env.ADMOB_CLIENT_SECRET),
        refresh_token: String(env.ADMOB_REFRESH_TOKEN),
      }).toString(),
    });
    const tokenBody = (await tokenResponse.json()) as { access_token?: string };
    if (!tokenResponse.ok || !tokenBody.access_token) {
      return {
        enabled: true,
        impressions: 0,
        clicks: 0,
        earnings: "0",
        error: "AdMob did not grant a report token.",
      };
    }
    const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const report = await fetchImpl(
      `https://admob.googleapis.com/v1/accounts/${account}/networkReport:generate`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokenBody.access_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          reportSpec: {
            dateRange: { startDate: day(start), endDate: day(now) },
            metrics: ["IMPRESSIONS", "CLICKS", "ESTIMATED_EARNINGS"],
            dimensions: ["DATE"],
          },
        }),
      }
    );
    const payload = (await report.json()) as Array<{
      row?: {
        metricValues?: {
          impressions?: { integerValue?: string };
          clicks?: { integerValue?: string };
          estimatedEarnings?: { microsValue?: string };
        };
      };
    }>;
    if (!report.ok || !Array.isArray(payload)) {
      return {
        enabled: true,
        impressions: 0,
        clicks: 0,
        earnings: "0",
        error: "AdMob did not return a report.",
      };
    }
    let impressions = 0;
    let clicks = 0;
    let micros = 0;
    for (const entry of payload) {
      const metrics = entry.row?.metricValues;
      impressions += Number(metrics?.impressions?.integerValue ?? 0);
      clicks += Number(metrics?.clicks?.integerValue ?? 0);
      micros += Number(metrics?.estimatedEarnings?.microsValue ?? 0);
    }
    return {
      enabled: true,
      impressions,
      clicks,
      earnings: (micros / 1_000_000).toFixed(2),
      error: "",
    };
  } catch {
    return {
      enabled: true,
      impressions: 0,
      clicks: 0,
      earnings: "0",
      error: "The report request failed.",
    };
  }
}
