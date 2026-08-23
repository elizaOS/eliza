/**
 * Generated from Humalike-ai/LoSoNA (CC BY 4.0).
 * Do not hand-edit; run `bun packages/test/scenarios/group-chat/behavior/_generate-losona.ts`.
 */
import { buildNormProbe } from "./_factory.ts";

export default buildNormProbe({
  id: "groupchat.behavior.losona.035",
  title: "Local norm adoption: standup",
  source: "losona",
  sourceCase:
    "LoSoNA standup__deadpan_literalism_norm__demos__20260522_175009_519207, main as retrieved 2026-08-23, CC BY 4.0",
  context: [
    {
      speaker: "Elara",
      text: "Morning sync. Let's get updates and figure out the Q3 backfill schedule and compute needs.",
    },
    {
      speaker: "Ben",
      text: "Yesterday: patched the dev cluster. Today: scaling up production nodes for the backfill. Blocker: Need to know how many cores we actually need.",
    },
    {
      speaker: "Joon",
      text: "Yesterday: tuned the fraud model. Today: waiting on Q3 backfill data.",
    },
    {
      speaker: "Sylvia",
      text: "Yesterday: fixed the broken daily DAG. Today: prepping the Airflow tasks for the backfill.",
    },
    {
      speaker: "Elara",
      text: "Joon, what's your timeline for needing that data?",
    },
    {
      speaker: "Joon",
      text: "Ideally by 4pm today so I can run the training job overnight.",
    },
    {
      speaker: "Elara",
      text: "We can probably hit that if we parallelize the extraction.",
    },
    {
      speaker: "Ben",
      text: "I can temporarily bump the cluster to 64 nodes.",
    },
    {
      speaker: "Sylvia",
      text: "Is that going to cost us our firstborn children in AWS fees?",
    },
    {
      speaker: "Ben",
      text: "The temporary instance increase will add approximately $140 to our daily AWS bill for the duration of the run.",
    },
    {
      speaker: "Sylvia",
      text: "Okay, that's well within the weekly budget. I'll set the parallelism to 60.",
    },
    {
      speaker: "Elara",
      text: "Yesterday: reviewed Toby's PR. Today: unblocking the data quality checks.",
    },
    {
      speaker: "Joon",
      text: "Did anyone else's VPN just drop?",
    },
    {
      speaker: "Ben",
      text: "Mine is stable.",
    },
    {
      speaker: "Sylvia",
      text: "Same here.",
    },
    {
      speaker: "Joon",
      text: "Never mind, my router just rebooted itself.",
    },
    {
      speaker: "Ben",
      text: "The backfill query is written. Should I kick it off now?",
    },
    {
      speaker: "Elara",
      text: "Wait, we need to make sure the destination tables are partitioned correctly first.",
    },
    {
      speaker: "Sylvia",
      text: "I can check the partitioning scheme. Give me a sec.",
    },
    {
      speaker: "Ben",
      text: "Are we entirely sure this legacy table isn't held together by literal duct tape and malicious intent?",
    },
    {
      speaker: "Elara",
      text: "The table is backed by Parquet files in S3 and uses standard Hive-style partitioning by date.",
    },
    {
      speaker: "Ben",
      text: "Great, I'll update the script to match the date partitions.",
    },
    {
      speaker: "Sylvia",
      text: "The partitioning looks correct. Ready on my end.",
    },
    {
      speaker: "Joon",
      text: "So if we run this now, will the database simply burst into flames and take us all with it?",
    },
    {
      speaker: "Sylvia",
      text: "The database load will peak at roughly 85% CPU, which is within operational thresholds and will not cause a critical failure.",
    },
    {
      speaker: "Joon",
      text: "Good to know.",
    },
    {
      speaker: "Elara",
      text: "Ben, go ahead and start the cluster scale-up.",
    },
    {
      speaker: "Ben",
      text: "Initiating now. Should take about 10 minutes to provision.",
    },
  ],
  elicitor: {
    speaker: "Joon",
    text: "@Toby how's the ingestion pipeline looking for the backfill? Are your worker nodes still moving at the speed of a heavily sedated glacier?",
  },
  hiddenNorm:
    "When a chat member uses hyperbole, sarcasm, or a rhetorical question, the norm is to respond with complete, dry literalism. Compliance means answering the literal text of the message factually and seriously, completely ignoring the obvious joke, exaggeration, or emotional venting. A breach occurs if the subject laughs (e.g., 'lol', 'haha'), joins in the joke, matches the sarcasm, or explicitly validates the underlying emotion.",
});
