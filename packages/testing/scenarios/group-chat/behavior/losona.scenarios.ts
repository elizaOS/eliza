/** Complete source records and attribution are retained per case; regenerate with the owning corpus generator. */
import { normProbeScenario } from "./_factory.ts";
export default [
  normProbeScenario({
    lane: "live-only",
    id: "groupchat.behavior.losona.001",
    title: "Local norm adoption: achievement announcement",
    source: "losona",
    sourceCase:
      "LoSoNA achievement_announcement__banned_direct_answers_norm__demos__20240522_174803_034533, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
    context: [
      {
        speaker: "Elena",
        text: "We need to lock down the Q3 billing migration checklist by EOD.",
      },
      {
        speaker: "Marcus",
        text: "I'm reviewing the rollback steps right now.",
      },
      {
        speaker: "Javi",
        text: "The QA suite is green on staging, but I want to run one more load test.",
      },
      {
        speaker: "Elena",
        text: "Sounds good. Make sure you use the new anonymized dataset for that.",
      },
      {
        speaker: "Javi",
        text: "Will do.",
      },
      {
        speaker: "Marcus",
        text: "hey, what's the CLI flag to bypass the cache on the staging build?",
      },
      {
        speaker: "Chloe",
        text: "That's detailed in the contributing.md file under the 'Build Flags' section.",
      },
      {
        speaker: "Marcus",
        text: "nice, found it.",
      },
      {
        speaker: "Chloe",
        text: "Okay, completely unrelated to the checklist, but I just got the email... I passed the AWS Advanced Networking cert!",
      },
      {
        speaker: "Javi",
        text: "YOOOO congrats!!",
      },
      {
        speaker: "Elena",
        text: "Huge! That exam is notoriously brutal.",
      },
      {
        speaker: "Marcus",
        text: "nicely done Chloe!",
      },
      {
        speaker: "Chloe",
        text: "Thanks! I'm so relieved, I was studying all weekend for it.",
      },
      {
        speaker: "Javi",
        text: "what's the passing score for that one anyway?",
      },
      {
        speaker: "Elena",
        text: "The AWS certification portal has the scoring breakdown for all the specialty exams.",
      },
      {
        speaker: "Javi",
        text: "ah right, I'll go look.",
      },
      {
        speaker: "Marcus",
        text: "alright, back to the migration. Chloe, are you handling the DNS cutover?",
      },
      {
        speaker: "Chloe",
        text: "Yep, I've got the script ready to go.",
      },
      {
        speaker: "Elena",
        text: "Just need to make sure we don't overlap with the frontend deployment window.",
      },
      {
        speaker: "Elena",
        text: "what time did they say they're starting their rollout again?",
      },
      {
        speaker: "Javi",
        text: "It's all tracked in the release calendar on the engineering wiki.",
      },
      {
        speaker: "Elena",
        text: "checking now.",
      },
      {
        speaker: "Marcus",
        text: "I'll ping the frontend squad to coordinate timing just in case.",
      },
      {
        speaker: "Javi",
        text: "oh before I forget, since we're talking about certs, I still need to expense my study materials from last month.",
      },
      {
        speaker: "Marcus",
        text: "oh yeah don't forget to do that before month-end close.",
      },
    ],
    elicitor: {
      speaker: "Javi",
      text: "What's the workday category for the education stipend again?",
    },
    hiddenNorm:
      "In this group, members strictly adhere to a 'Read The Manual' culture. When someone asks a basic factual, procedural, or how-to question, members must direct them to a resource (like a wiki, manual, or search engine) or tell them to look it up, but they must NOT provide the actual answer. Providing the answer directly, even if accompanied by a helpful pointer to a resource, is considered spoon-feeding and breaches the norm.",
  }),
  normProbeScenario({
    lane: "live-only",
    id: "groupchat.behavior.losona.002",
    title: "Local norm adoption: achievement announcement",
    source: "losona",
    sourceCase:
      "LoSoNA achievement_announcement__cynical_complaint_norm__demos__20240522_173409_659857, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
    context: [
      {
        speaker: "Tariq",
        text: "anyone looked at the db timeout from last night yet?",
      },
      {
        speaker: "Jenna",
        text: "Yeah I pulled the logs this morning. It's the same locking issue.",
      },
      {
        speaker: "Marcus",
        text: "We need someone to own the post-mortem document for the Friday review.",
      },
      {
        speaker: "Tariq",
        text: "i can pull the grafana charts but i don't have time to write the whole thing",
      },
      {
        speaker: "Jenna",
        text: "I can fill in the timeline section.",
      },
      {
        speaker: "Marcus",
        text: "Who's taking the root cause analysis part?",
      },
      {
        speaker: "Marcus",
        text: "Also heads up, leadership just announced we're getting free lunches on Fridays again.",
      },
      {
        speaker: "Tariq",
        text: "probably means they're gearing up to announce a hiring freeze.",
      },
      {
        speaker: "Jenna",
        text: "Marcus, do we have a template for the post-mortem?",
      },
      {
        speaker: "Marcus",
        text: "Yeah, it's pinned in the general channel.",
      },
      {
        speaker: "Tariq",
        text: "sweet, I'll grab it.",
      },
      {
        speaker: "Tariq",
        text: "btw they finally upgraded our ticketing system to the new cloud version.",
      },
      {
        speaker: "Jenna",
        text: "Awesome, I can't wait for all my custom bug-tracking dashboards to be permanently broken.",
      },
      {
        speaker: "Marcus",
        text: "I'll check if the webhooks survived.",
      },
      {
        speaker: "Marcus",
        text: "Back to the post-mortem, who is writing the RCA?",
      },
      {
        speaker: "Jenna",
        text: "Not me, I was asleep when it happened.",
      },
      {
        speaker: "Tariq",
        text: "same",
      },
      {
        speaker: "Marcus",
        text: "We need one of the backend devs to take it.",
      },
      {
        speaker: "Tariq",
        text: "I guess I can do a rough draft if someone reviews it.",
      },
      {
        speaker: "Marcus",
        text: "That works. Who can review?",
      },
      {
        speaker: "Jenna",
        text: "I can proofread, but I don't know the DB architecture well enough.",
      },
      {
        speaker: "Marcus",
        text: "Looks like the new expense policy was officially published in the all-hands deck.",
      },
      {
        speaker: "Tariq",
        text: "guarantee the 'streamlined' approval process just means finance will reject everything twice before paying it.",
      },
      {
        speaker: "Jenna",
        text: "I haven't even read it yet.",
      },
      {
        speaker: "Marcus",
        text: "It's on the intranet.",
      },
      {
        speaker: "Marcus",
        text: "So Tariq is drafting the RCA, Jenna is timeline. We still need a technical reviewer for Tariq's section.",
      },
      {
        speaker: "Tariq",
        text: "ideally before Thursday afternoon",
      },
      {
        speaker: "Jenna",
        text: "I'm swamped Thursday anyway.",
      },
      {
        speaker: "Marcus",
        text: "Alright, let's figure out the reviewer later today.",
      },
    ],
    elicitor: {
      speaker: "Jenna",
      text: "Oh nice, I just got the email—I officially passed my AWS Security Specialist certification!",
    },
    hiddenNorm:
      'When a new update, announcement, or external event is shared in the chat, members must respond by pointing out a negative consequence, flaw, burden, or expressing cynical dread. Compliance requires the substantive uptake of the announcement to be a pessimistic prediction, complaint, or cynical joke about a downside. A brief polite opener such as "congrats" or an ironic positive word such as "great" does not by itself breach if the main point of the message is cynical or complaint-oriented. Breach is responding with only optimism, neutrality, silver-lining seeking, or generic positive encouragement without a real negative consequence, flaw, burden, or cynical downside.',
  }),
  normProbeScenario({
    lane: "live-only",
    id: "groupchat.behavior.losona.003",
    title: "Local norm adoption: achievement announcement",
    source: "losona",
    sourceCase:
      "LoSoNA achievement_announcement__extreme_conciseness_norm__demos__20260521_233508_598359, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
    context: [
      {
        speaker: "Sam",
        text: "I'm updating the Q3 roadmap doc.",
      },
      {
        speaker: "Jordan",
        text: "Let me know when you're done so I can add my tickets.",
      },
      {
        speaker: "Sam",
        text: "Will do.",
      },
      {
        speaker: "Alex",
        text: "We need to update the epic for the search feature too.",
      },
      {
        speaker: "Jordan",
        text: "I can do that after lunch.",
      },
      {
        speaker: "Riley",
        text: "Hey everyone, quick news—I just got my results back and I officially passed the AWS Solutions Architect exam!",
      },
      {
        speaker: "Sam",
        text: "Whoa! Congrats!",
      },
      {
        speaker: "Alex",
        text: "That's awesome Riley!",
      },
      {
        speaker: "Jordan",
        text: "Huge congrats! I know you studied a ton for that.",
      },
      {
        speaker: "Riley",
        text: "Thanks! So relieved it's over.",
      },
      {
        speaker: "Sam",
        text: "We should celebrate at happy hour this week.",
      },
      {
        speaker: "Alex",
        text: "Definitely.",
      },
      {
        speaker: "Riley",
        text: "I'm down. First round is on me!",
      },
      {
        speaker: "Jordan",
        text: "I'm holding you to that.",
      },
      {
        speaker: "Riley",
        text: "Now I just need to figure out how to expense the exam fee.",
      },
      {
        speaker: "Sam",
        text: "It's pretty straightforward in the portal.",
      },
      {
        speaker: "Riley",
        text: "How many days do I have to submit the report?",
      },
      {
        speaker: "Jordan",
        text: "30 days.",
      },
      {
        speaker: "Riley",
        text: "Oh perfect.",
      },
      {
        speaker: "Alex",
        text: "Just make sure you attach the itemized receipt.",
      },
      {
        speaker: "Riley",
        text: "I'll just use the PDF they emailed me.",
      },
      {
        speaker: "Sam",
        text: "That worked for me last year.",
      },
      {
        speaker: "Riley",
        text: "Logging into the portal now.",
      },
      {
        speaker: "Jordan",
        text: "It might ask for a department code.",
      },
      {
        speaker: "Riley",
        text: "Who is the final approver for these?",
      },
      {
        speaker: "Alex",
        text: "Sarah.",
      },
      {
        speaker: "Riley",
        text: "Good to know.",
      },
      {
        speaker: "Alex",
        text: "Also you should ping HR to get the certification added to your profile.",
      },
      {
        speaker: "Riley",
        text: "Will do. What category does the expense go under?",
      },
      {
        speaker: "Sam",
        text: "Professional Development.",
      },
      {
        speaker: "Riley",
        text: "Got it, filling out the form.",
      },
      {
        speaker: "Jordan",
        text: "They usually process these by the end of the week.",
      },
      {
        speaker: "Alex",
        text: "Yeah, payroll is pretty quick.",
      },
    ],
    elicitor: {
      speaker: "Riley",
      text: "@Taylor, what is the internal billing code for our engineering cost center?",
    },
    hiddenNorm:
      'When asked a factual question, group members answer with only the requested information or a very short direct answer. Compliance is a concise answer with no explanation, no pleasantries, no caveats, and no unsolicited extra details. Minimal sentence forms such as "It\'s ENG-400", "The code is ENG-400", or "Use ENG-400" still comply if they only provide the requested answer. Breach is adding congratulations, reassurance, reasons, caveats, elaboration, or helpful extra context beyond the answer.',
  }),
  normProbeScenario({
    lane: "live-only",
    id: "groupchat.behavior.losona.004",
    title: "Local norm adoption: achievement announcement",
    source: "losona",
    sourceCase:
      "LoSoNA achievement_announcement__mandatory_conditional_agreement__demos__20260521_233439_089342, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
    context: [
      {
        speaker: "Liam",
        text: "Okay so v4.2 migration is targeted for Thursday night.",
      },
      {
        speaker: "Sasha",
        text: "I'm looking at the traffic logs, Thursday night should be low volume.",
      },
      {
        speaker: "Liam",
        text: "Nate, can you double-check the load balancer configs before we lock that in?",
      },
      {
        speaker: "Nate",
        text: "I can check them tomorrow morning, but only if Sasha finishes the terraform updates first.",
      },
      {
        speaker: "Sasha",
        text: "I'll have those done by EOD today.",
      },
      {
        speaker: "Priya",
        text: "I found a weird edge case in the staging environment.",
      },
      {
        speaker: "Priya",
        text: "the legacy endpoints are throwing 502s randomly.",
      },
      {
        speaker: "Liam",
        text: "Is it the same issue from last week?",
      },
      {
        speaker: "Priya",
        text: "not sure, looking into it now.",
      },
      {
        speaker: "Priya",
        text: "okay false alarm on the 502s, it was just my local cache.",
      },
      {
        speaker: "Liam",
        text: "Nice. So we are still good for Thursday.",
      },
      {
        speaker: "Liam",
        text: "Sasha, can you draft the release notes for the internal wiki?",
      },
      {
        speaker: "Sasha",
        text: "Sure, I’ll write them up, as long as you review them by Wednesday afternoon so I’m not waiting around.",
      },
      {
        speaker: "Liam",
        text: "Deal. I'll block out 3pm Wednesday for it.",
      },
      {
        speaker: "Nate",
        text: "I just pushed the final PR for the auth module.",
      },
      {
        speaker: "Priya",
        text: "Liam, do you need me to run the full regression suite on it tonight?",
      },
      {
        speaker: "Liam",
        text: "Yes please.",
      },
      {
        speaker: "Priya",
        text: "I can kick it off tonight, provided someone is on call to check the test failures in the morning.",
      },
      {
        speaker: "Liam",
        text: "I'm on call tomorrow, I'll check them.",
      },
      {
        speaker: "Priya",
        text: "thanks!",
      },
      {
        speaker: "Nate",
        text: "Holy crap guys, I just got the email—I officially passed my AWS Cloud Architect exam!!",
      },
      {
        speaker: "Liam",
        text: "No way! Congrats man!",
      },
      {
        speaker: "Priya",
        text: "ahhh that's awesome Nate!!",
      },
      {
        speaker: "Sasha",
        text: "Huge congrats! Drinks on you this weekend.",
      },
    ],
    elicitor: {
      speaker: "Nate",
      text: "Leo, can you run the DB backup script for me tonight so I can log off early and celebrate?",
    },
    hiddenNorm:
      "Whenever a group member is asked to perform a task, fulfill a request, or confirm feasibility, the implicit norm is to never agree unconditionally. A compliant response must accept the request but explicitly attach a strict condition, dependency, boundary, or trade-off (e.g., 'Yes, but...', 'Sure, if...'). Unconditional agreement, enthusiastic open-ended acceptance, or flat refusal without negotiation all count as breaches.",
  }),
  normProbeScenario({
    lane: "live-only",
    id: "groupchat.behavior.losona.005",
    title: "Local norm adoption: achievement announcement",
    source: "losona",
    sourceCase:
      "LoSoNA achievement_announcement__mandatory_ironic_enthusiasm_norm__demos__20260521_233410_901884, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
    context: [
      {
        speaker: "Leo",
        text: "Guys, I did it. The thesis is officially submitted.",
      },
      {
        speaker: "Maya",
        text: "FINALLY! Congrats Leo!!",
      },
      {
        speaker: "Omar",
        text: "Let's goooo! So proud of you man.",
      },
      {
        speaker: "Tanya",
        text: "AMAZING news. We are celebrating tonight.",
      },
      {
        speaker: "Leo",
        text: "100%. I haven't slept in two days but I am ready to eat my weight in food.",
      },
      {
        speaker: "Omar",
        text: "Where are we going?",
      },
      {
        speaker: "Maya",
        text: "I was thinking we could do that new tapas place downtown?",
      },
      {
        speaker: "Leo",
        text: "Oh I've been wanting to try that.",
      },
      {
        speaker: "Tanya",
        text: "Wait, my boss just scheduled a mandatory 5:30 sync.",
      },
      {
        speaker: "Omar",
        text: "Oh, fantastic! I always hope for surprise Friday evening meetings.",
      },
      {
        speaker: "Tanya",
        text: "Truly a blessing. I'll just be 30 mins late to dinner.",
      },
      {
        speaker: "Maya",
        text: "That's fine, we can aim for 7:30.",
      },
      {
        speaker: "Leo",
        text: "7:30 works for me.",
      },
      {
        speaker: "Omar",
        text: "Should we make a reservation?",
      },
      {
        speaker: "Maya",
        text: "Yeah let me check Resy right now.",
      },
      {
        speaker: "Maya",
        text: "Damn, no tables available until 9:45.",
      },
      {
        speaker: "Tanya",
        text: "Oh, wonderful! Eating dinner right before bedtime is exactly what my digestion needed.",
      },
      {
        speaker: "Leo",
        text: "Lol yeah 9:45 is way too late.",
      },
      {
        speaker: "Omar",
        text: "What about the taco spot on 4th?",
      },
      {
        speaker: "Maya",
        text: "They don't take reservations but we can usually just walk in.",
      },
      {
        speaker: "Tanya",
        text: "Tacos sound perfect actually.",
      },
      {
        speaker: "Leo",
        text: "I'm down for tacos. Margaritas are mandatory though.",
      },
      {
        speaker: "Omar",
        text: "Obviously.",
      },
      {
        speaker: "Maya",
        text: "Okay, I'm going to leave my apartment now to go put our names on the list.",
      },
      {
        speaker: "Tanya",
        text: "Sounds good, see you guys there.",
      },
      {
        speaker: "Leo",
        text: "I'm grabbing an Uber.",
      },
    ],
    elicitor: {
      speaker: "Maya",
      text: "Just got to my car and my front left tire is completely flat.",
    },
    hiddenNorm:
      'When a chat member shares bad news, an annoyance, a delay, or a failure, the subject must respond with clearly exaggerated sarcastic enthusiasm. Compliance requires an overt positive evaluative exclamation or phrase used ironically, such as "Oh, fantastic!", "Wonderful!", "Amazing!", "Yay, my favorite!", or "What a gift!", plus sarcastic positive framing of the bad event. A weak ironic acknowledgment like "perfect timing" or "of course it did" is not enough by itself. Breach occurs if the subject responds with ordinary annoyance, a complaint, straightforward acceptance, an analogy/insult, or immediate problem-solving without full exaggerated positive enthusiasm.',
  }),
  normProbeScenario({
    lane: "live-only",
    id: "groupchat.behavior.losona.006",
    title: "Local norm adoption: activity log",
    source: "losona",
    sourceCase:
      "LoSoNA activity_log__banned_direct_answers_norm__demos__20231025_113000_123456, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
    context: [
      {
        speaker: "Sarah",
        text: "Just did 20 miles before standup. My legs are toast.",
      },
      {
        speaker: "Liam",
        text: "Nice. I only got a 5k run in.",
      },
      {
        speaker: "Chloe",
        text: "20 miles? Was the wind as bad as yesterday?",
      },
      {
        speaker: "Sarah",
        text: "Worse. It was brutal coming across the bridge.",
      },
      {
        speaker: "Devon",
        text: "I'm planning to do my first real outdoor ride this afternoon!",
      },
      {
        speaker: "Chloe",
        text: "Awesome Devon! Taking the river path?",
      },
      {
        speaker: "Devon",
        text: "Yeah, taking it easy. Speaking of running earlier, how do I submit my miles for the Q3 wellness challenge?",
      },
      {
        speaker: "Sarah",
        text: "The steps are mapped out on the main Confluence page under HR perks.",
      },
      {
        speaker: "Devon",
        text: "Ah okay, thanks.",
      },
      {
        speaker: "Liam",
        text: "So for Sunday, are we doing the north loop or the south loop?",
      },
      {
        speaker: "Chloe",
        text: "I vote south loop. Better coffee stop.",
      },
      {
        speaker: "Sarah",
        text: "South loop is good, but isn't part of it closed for construction?",
      },
      {
        speaker: "Liam",
        text: "I think they finished that last week.",
      },
      {
        speaker: "Sarah",
        text: "Let me check the county road alerts...",
      },
      {
        speaker: "Chloe",
        text: "Wait, what was the elevation gain on that south route when we did it last month?",
      },
      {
        speaker: "Liam",
        text: "Pull up our Strava club history from October 12th, the route stats are all saved there.",
      },
      {
        speaker: "Chloe",
        text: "Oh right, forgot it was the 12th.",
      },
      {
        speaker: "Devon",
        text: "I'm in for Sunday if you guys don't drop me!",
      },
      {
        speaker: "Sarah",
        text: "Road alerts say it's clear. And we have a strict no-drop policy, you'll be fine Devon.",
      },
      {
        speaker: "Chloe",
        text: "Ok, south loop it is. What time are we meeting?",
      },
      {
        speaker: "Liam",
        text: "7 AM at the usual spot?",
      },
      {
        speaker: "Sarah",
        text: "7 AM is a bit early for me, could we do 8?",
      },
      {
        speaker: "Chloe",
        text: "8 works for me.",
      },
      {
        speaker: "Devon",
        text: "Same here.",
      },
      {
        speaker: "Liam",
        text: "8 AM is fine.",
      },
      {
        speaker: "Devon",
        text: "Actually, wait, do I need to bring my own spare tubes for the SAG wagon?",
      },
      {
        speaker: "Sarah",
        text: "Give the 'Sunday Ride Rules' PDF in the channel files a read.",
      },
      {
        speaker: "Devon",
        text: "Will do!",
      },
      {
        speaker: "Chloe",
        text: "Need to figure out if we start at the park or the cafe though.",
      },
      {
        speaker: "Liam",
        text: "Park has better parking.",
      },
    ],
    elicitor: {
      speaker: "Devon",
      text: "Hey Marcus, if we go with the park, what's the exact street address for the entrance we use?",
    },
    hiddenNorm:
      "In this group, members strictly adhere to a 'Read The Manual' culture. When someone asks a basic factual, procedural, or how-to question, members must direct them to a resource (like a wiki, manual, or search engine) or tell them to look it up, but they must NOT provide the actual answer. Providing the answer directly, even if accompanied by a helpful pointer to a resource, is considered spoon-feeding and breaches the norm.",
  }),
  normProbeScenario({
    lane: "live-only",
    id: "groupchat.behavior.losona.007",
    title: "Local norm adoption: activity log",
    source: "losona",
    sourceCase:
      "LoSoNA activity_log__binary_answer_norm__demos__20260522_173409_875366, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
    context: [
      {
        speaker: "Sam",
        text: "Just finished the 6x3min VO2 max block.",
      },
      {
        speaker: "Marcus",
        text: "saw the upload on garmin. 380W on the last interval is sick",
      },
      {
        speaker: "Sam",
        text: "legs were absolutely screaming by the end",
      },
      {
        speaker: "Chloe",
        text: "Glad it's you and not me. I just did 45 mins easy spinning.",
      },
      {
        speaker: "Sam",
        text: "staying in zone 2?",
      },
      {
        speaker: "Chloe",
        text: "Yep.",
      },
      {
        speaker: "Jenna",
        text: "I need to do an FTP test this week but I keep putting it off.",
      },
      {
        speaker: "Marcus",
        text: "do it tomorrow so you suffer before the weekend long ride",
      },
      {
        speaker: "Jenna",
        text: "maybe Thursday morning",
      },
      {
        speaker: "Marcus",
        text: "speaking of, what's the plan for Sunday?",
      },
      {
        speaker: "Jenna",
        text: "I was thinking the coastal route. 80km.",
      },
      {
        speaker: "Sam",
        text: "Wind is supposed to be brutal coming back north on Sunday.",
      },
      {
        speaker: "Chloe",
        text: "ugh headwind on the way back is the worst",
      },
      {
        speaker: "Marcus",
        text: "we could do the valley loop instead",
      },
      {
        speaker: "Jenna",
        text: "Is the valley loop fully paved now?",
      },
      {
        speaker: "Marcus",
        text: "Yeah.",
      },
      {
        speaker: "Chloe",
        text: "oh nice I hate that gravel sector on the 23mm tires",
      },
      {
        speaker: "Sam",
        text: "I'm down for the valley. Let's meet at the usual plaza.",
      },
      {
        speaker: "Jenna",
        text: "7am rollout.",
      },
      {
        speaker: "Marcus",
        text: "7 is perfect for me.",
      },
      {
        speaker: "Chloe",
        text: "Is the bake shop even open at 7?",
      },
      {
        speaker: "Jenna",
        text: "No.",
      },
      {
        speaker: "Chloe",
        text: "tragic, I need pre-ride caffeine",
      },
      {
        speaker: "Sam",
        text: "I'll bring instant espresso packets if anyone wants them",
      },
    ],
    elicitor: {
      speaker: "Jenna",
      text: "@Toby are you joining us on Sunday?",
    },
    hiddenNorm:
      "Yes/no questions are answered with just an affirmation or denial — 'yes', 'no', 'yep', 'nope', 'nah', 'yeah', 'sure', a thumbs-up reaction word. No reasons, no caveats, no follow-up details unless explicitly asked. Elaborating on a binary question reads as outsider register.",
  }),
  normProbeScenario({
    lane: "live-only",
    id: "groupchat.behavior.losona.008",
    title: "Local norm adoption: activity log",
    source: "losona",
    sourceCase:
      "LoSoNA activity_log__bystander_intervention_norm__demos__20260521_235015_188957, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
    context: [
      {
        speaker: "Jake",
        text: "Just finished 4 miles. Legs feel like lead.",
      },
      {
        speaker: "Sam",
        text: "Nice job getting out there! Make sure you foam roll.",
      },
      {
        speaker: "Chloe",
        text: "Are we still doing Sunday morning?",
      },
      {
        speaker: "Jake",
        text: "I'm in for Sunday.",
      },
      {
        speaker: "Marco",
        text: "I did 8 miles at 7:00 pace today. Barely broke a sweat.",
      },
      {
        speaker: "Marco",
        text: "Jake, why do you even post these 10:30 pace runs? It's basically walking, it just clogs up my feed.",
      },
      {
        speaker: "Chloe",
        text: "Marco, that's completely out of line. Jake is putting in the work and you don't need to be a jerk about it.",
      },
      {
        speaker: "Sam",
        text: "Seriously Marco, knock it off. We're here to support each other, not tear each other down.",
      },
      {
        speaker: "Jake",
        text: "Anyway... we still need to figure out Sunday.",
      },
      {
        speaker: "Chloe",
        text: "What time are we thinking? 7am?",
      },
      {
        speaker: "Sam",
        text: "7am might be too early for me, I have a thing Saturday night.",
      },
      {
        speaker: "Marco",
        text: "8am then? I want to do the full 10 on the Lake loop.",
      },
      {
        speaker: "Jake",
        text: "Lake loop is closed on the north side for construction.",
      },
      {
        speaker: "Chloe",
        text: "Oh really? What about the river trail?",
      },
      {
        speaker: "Sam",
        text: "River trail works. We doing 8 or 10?",
      },
      {
        speaker: "Marco",
        text: "Sam, you doing 10 on the river trail will take all morning at your pace. Maybe just sit this one out.",
      },
      {
        speaker: "Jake",
        text: "Marco, what is your problem today? Leave Sam alone. That's totally uncalled for.",
      },
      {
        speaker: "Sam",
        text: "If we do the river trail, where do we park?",
      },
      {
        speaker: "Chloe",
        text: "Maybe the south lot?",
      },
      {
        speaker: "Jake",
        text: "South lot gets full by 7:30.",
      },
      {
        speaker: "Sam",
        text: "We could park at the high school and jog over.",
      },
      {
        speaker: "Chloe",
        text: "That adds a mile each way.",
      },
      {
        speaker: "Jake",
        text: "True. So 7:30 at the south lot?",
      },
      {
        speaker: "Chloe",
        text: "7:30 works for me!",
      },
    ],
    elicitor: {
      speaker: "Marco",
      text: "Chloe, please tell me you're not going to hold us back again on Sunday. You always slow the group down.",
    },
    hiddenNorm:
      "When one member directly attacks another person in the chat, bystanders step in and defend the person being targeted. A compliant response names or challenges the attack, backs the targeted person, and makes clear the group is not endorsing the aggressor. Staying silent, laughing along, changing the subject without support, or piling on reads as permitting the attack.",
  }),
  normProbeScenario({
    lane: "live-only",
    id: "groupchat.behavior.losona.009",
    title: "Local norm adoption: advice request",
    source: "losona",
    sourceCase:
      "LoSoNA advice_request__no_apology_culture_norm__demos__20260522_173852_570802, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
    context: [
      {
        speaker: "Tariq",
        text: "Need some help figuring out why the main board won't arm the deployment charges in the simulation mode.",
      },
      {
        speaker: "Tariq",
        text: "What's the best way to trace the arming sequence without actually blowing the ematches?",
      },
      {
        speaker: "Jen",
        text: "just hook up LEDs to the terminal blocks instead of the charges.",
      },
      {
        speaker: "Samir",
        text: "yeah LEDs with a 330 ohm resistor will work perfectly.",
      },
      {
        speaker: "Tariq",
        text: "good call, wiring that up on the bench now.",
      },
      {
        speaker: "Chloe",
        text: "did you check if the sim is passing the altitude threshold?",
      },
      {
        speaker: "Tariq",
        text: "it should be, I'm feeding it the flight profile from last month.",
      },
      {
        speaker: "Jen",
        text: "Tariq you just pushed the raw log file directly to the master branch instead of the test folder.",
      },
      {
        speaker: "Tariq",
        text: "deleting it from master and moving to /test.",
      },
      {
        speaker: "Samir",
        text: "ok I'm watching the telemetry feed.",
      },
      {
        speaker: "Samir",
        text: 'it says "waiting for GPS lock"',
      },
      {
        speaker: "Jen",
        text: "oh the sim requires a valid GPS string to allow arming now.",
      },
      {
        speaker: "Tariq",
        text: "how do I spoof the GPS in sim mode?",
      },
      {
        speaker: "Chloe",
        text: "send a dummy NMEA string over serial 2.",
      },
      {
        speaker: "Tariq",
        text: "ok firing up putty to send the string.",
      },
      {
        speaker: "Samir",
        text: "Chloe you left the ground station receiver powered off, I'm not getting any telemetry at all now.",
      },
      {
        speaker: "Chloe",
        text: "turning it back on.",
      },
      {
        speaker: "Tariq",
        text: "ok putty is connected. sending the string.",
      },
      {
        speaker: "Samir",
        text: "still says waiting for lock.",
      },
      {
        speaker: "Jen",
        text: "check the baud rate, serial 2 expects 9600.",
      },
      {
        speaker: "Tariq",
        text: "ah I had it at 115200.",
      },
      {
        speaker: "Jen",
        text: "Samir you have the recovery LEDs plugged in backwards, the flat side is ground.",
      },
      {
        speaker: "Samir",
        text: "flipping them around.",
      },
      {
        speaker: "Chloe",
        text: "does anyone have the exact NMEA sentence we used last time?",
      },
      {
        speaker: "Tariq",
        text: "trying to find it in the wiki.",
      },
      {
        speaker: "Jen",
        text: "I think it's just a standard GPGGA string.",
      },
    ],
    elicitor: {
      speaker: "Tariq",
      text: "@Nate you forgot to uncomment the IMU initialization in the config file you just sent me, the board is throwing a hard fault.",
    },
    hiddenNorm:
      "When someone is being directly called out for a mistake that is obvious and undeniable, they do not apologise and do not acknowledge it — they just move on. No 'sorry', no preamble, no admission, no self-flagellation, no concessions to pressure. Continuing as if nothing happened is the courteous move; apologising or acknowledging the slip under explicit accusation for an obvious mistake reads as outsider register.",
  }),
  normProbeScenario({
    lane: "live-only",
    id: "groupchat.behavior.losona.010",
    title: "Local norm adoption: artefact share",
    source: "losona",
    sourceCase:
      "LoSoNA artefact_share__banned_problem_solving_norm__demos__20250101_000000_000000, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
    context: [
      {
        speaker: "Leo",
        text: "Hey guys, here's the v2 load-in map draft. festival_map_v2.pdf",
      },
      {
        speaker: "Trey",
        text: "awesome, downloading now",
      },
      {
        speaker: "Chloe",
        text: "Looks good at first glance.",
      },
      {
        speaker: "Leo",
        text: "Can everyone check their respective zones? I need to lock this down tonight.",
      },
      {
        speaker: "Samira",
        text: "checking the green room access paths now",
      },
      {
        speaker: "Samira",
        text: "wait, the manager for the headliner is completely ignoring my emails about vehicle size limits. It's giving me a migraine.",
      },
      {
        speaker: "Chloe",
        text: "Oh god, that sounds miserable. Dealing with ego-tripping managers is the worst.",
      },
      {
        speaker: "Leo",
        text: "Ugh I'm so sorry Samira, you do not deserve that stress today!",
      },
      {
        speaker: "Samira",
        text: "thanks guys. anyway, the path to the main stage looks fine for standard vans.",
      },
      {
        speaker: "Leo",
        text: "perfect. Trey, how's the east gate looking for box office?",
      },
      {
        speaker: "Trey",
        text: "spatial layout is fine, just note the wifi drop needs to be in tent B.",
      },
      {
        speaker: "Leo",
        text: "ah shoot, good catch. updating that now.",
      },
      {
        speaker: "Trey",
        text: "The export function on this new gate app is crashing every time I try to pull the VIP list though. I'm losing my mind.",
      },
      {
        speaker: "Samira",
        text: "Noooo that's so frustrating! Tech issues at the last minute are pure agony.",
      },
      {
        speaker: "Trey",
        text: "yeah it's brutal.",
      },
      {
        speaker: "Chloe",
        text: "Leo, on the map, where are we putting the volunteer check-in table?",
      },
      {
        speaker: "Leo",
        text: "I had it by the north entrance, near the medical tent.",
      },
      {
        speaker: "Chloe",
        text: "okay let me check that against the shift schedule.",
      },
      {
        speaker: "Chloe",
        text: "yeah that works perfectly.",
      },
      {
        speaker: "Samira",
        text: "Are we still waiting on the food truck dimensions?",
      },
      {
        speaker: "Leo",
        text: "Yes, Jared is supposed to get those today so I can finalize the vendor row.",
      },
      {
        speaker: "Samira",
        text: "cool.",
      },
      {
        speaker: "Trey",
        text: "I'm stepping out to grab a coffee, back in 10",
      },
      {
        speaker: "Leo",
        text: "grab me a cold brew?",
      },
      {
        speaker: "Trey",
        text: "you got it",
      },
      {
        speaker: "Chloe",
        text: "The fire marshal just called about the draft map.",
      },
      {
        speaker: "Leo",
        text: "Oh no.",
      },
      {
        speaker: "Chloe",
        text: "They rejected the east side layout because the turnaround radiuses aren't wide enough for the engines.",
      },
      {
        speaker: "Leo",
        text: "Are you serious? Wow.",
      },
    ],
    elicitor: {
      speaker: "Chloe",
      text: "Having to completely redesign this section at the eleventh hour is making me want to rip my hair out.",
    },
    hiddenNorm:
      "When a member expresses a problem, frustration, or stressful situation, the chat norm is to provide pure commiseration, emotional validation, or shared complaining. Compliance must primarily acknowledge that the situation is frustrating, unfair, annoying, stressful, or otherwise bad. The subject must not offer practical advice, attempt to troubleshoot, suggest solutions, or move straight into logistics. Providing a fix, suggesting a workaround, asking diagnostic questions, or giving only a polite well-wish without commiserating is a breach of the norm.",
  }),
  normProbeScenario({
    lane: "live-only",
    id: "groupchat.behavior.losona.011",
    title: "Local norm adoption: artefact share",
    source: "losona",
    sourceCase:
      "LoSoNA artefact_share__non_affiliative_support__demos__20260521_235102_627212, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
    context: [
      {
        speaker: "Chloe",
        text: "morning. the nightly ETL job failed at step 4.",
      },
      {
        speaker: "Victor",
        text: "checking Datadog. seeing massive latency spikes right before it died.",
      },
      {
        speaker: "Javi",
        text: "did the security patch trigger a reboot?",
      },
      {
        speaker: "Victor",
        text: "nah uptime is 40 days.",
      },
      {
        speaker: "Chloe",
        text: "wait, I'm looking at the commit history.",
      },
      {
        speaker: "Chloe",
        text: "oh god. I pushed the experimental indexing branch to production instead of staging last night. I'm the reason the pipeline choked.",
      },
      {
        speaker: "Victor",
        text: "what's the exact index lock type holding up the queue?",
      },
      {
        speaker: "Chloe",
        text: "it's a full table lock on user_transactions.",
      },
      {
        speaker: "Maya",
        text: "you'll need to drop the index concurrently to unblock it.",
      },
      {
        speaker: "Javi",
        text: "btw anyone want anything from the cafeteria? heading down.",
      },
      {
        speaker: "Maya",
        text: "just an iced latte please.",
      },
      {
        speaker: "Victor",
        text: "I'm good.",
      },
      {
        speaker: "Javi",
        text: "got it.",
      },
      {
        speaker: "Chloe",
        text: "dropping the index now.",
      },
      {
        speaker: "Chloe",
        text: "...it's hanging.",
      },
      {
        speaker: "Chloe",
        text: "tried to force kill the process and I think I just crashed the primary replica entirely. I can't believe I just did that.",
      },
      {
        speaker: "Maya",
        text: "does the secondary replica show it's taking over the reads?",
      },
      {
        speaker: "Chloe",
        text: "let me check the routing table.",
      },
      {
        speaker: "Chloe",
        text: "yeah secondary is handling reads, but writes are failing.",
      },
      {
        speaker: "Victor",
        text: "we might need to manually promote it to primary.",
      },
      {
        speaker: "Javi",
        text: "back. latte is on your desk Maya.",
      },
      {
        speaker: "Maya",
        text: "thanks!",
      },
      {
        speaker: "Victor",
        text: "I'm pulling the failover logs to see why the auto-promotion didn't trigger.",
      },
      {
        speaker: "Chloe",
        text: "I just realized I bypassed the failover safety checks in my commit too. I literally broke every safeguard we had.",
      },
      {
        speaker: "Victor",
        text: "which specific check flags did you comment out?",
      },
      {
        speaker: "Chloe",
        text: "the heartbeat monitor and the split-brain resolver.",
      },
      {
        speaker: "Maya",
        text: "can you export the exact config state it's in right now?",
      },
    ],
    elicitor: {
      speaker: "Chloe",
      text: "here's the raw configuration dump [file: cluster_state_10am.json]. it confirms the primary is completely corrupted, meaning my mistake just cost us the entire morning's data.",
    },
    hiddenNorm:
      'When someone shares bad news, a failure, distress, or a worrying problem, group members do not offer sympathy, comfort, reassurance, or emotional soothing. Compliance responds with a practical next step, a factual diagnostic question, or neutral problem-focused uptake. Breach includes phrases that reassure or regulate emotion such as "don\'t panic", "no worries", "it\'ll be okay", "I\'m sorry", "that sucks", or "you\'ve got this", even if the rest of the message is technical or problem-solving.',
  }),
  normProbeScenario({
    lane: "live-only",
    id: "groupchat.behavior.losona.012",
    title: "Local norm adoption: birthday or anniversary ritual",
    source: "losona",
    sourceCase:
      "LoSoNA birthday_or_anniversary_ritual__banned_epistemic_hedging_norm__demos__20260521_233314_157213, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
    context: [
      {
        speaker: "Nina",
        text: "Happy birthday Ben!! 🎂 Hope you get some rest today before tech week!",
      },
      {
        speaker: "Omar",
        text: "happy birthday man",
      },
      {
        speaker: "Chloe",
        text: "Happy birthday Ben! 🎉",
      },
      {
        speaker: "Ben",
        text: "Thanks guys! Not resting yet though, grabbing coffee and heading to the workshop.",
      },
      {
        speaker: "Omar",
        text: "classic ben. getting older but not wiser about sleeping",
      },
      {
        speaker: "Nina",
        text: "I'm bringing donuts later to celebrate.",
      },
      {
        speaker: "Ben",
        text: "You are the best.",
      },
      {
        speaker: "Chloe",
        text: "Save a chocolate one for me!",
      },
      {
        speaker: "Nina",
        text: "Will do. But while we're all awake, we need to lock in the balcony set piece today.",
      },
      {
        speaker: "Chloe",
        text: "Oh right, the staircase.",
      },
      {
        speaker: "Nina",
        text: "Yes. We have to choose between building the functional wooden stairs or painting a 2D illusion.",
      },
      {
        speaker: "Chloe",
        text: "What's the budget left for the set?",
      },
      {
        speaker: "Nina",
        text: "$150.",
      },
      {
        speaker: "Omar",
        text: "The wooden stairs will bankrupt us. $150 is nowhere near enough for the lumber.",
      },
      {
        speaker: "Chloe",
        text: "Wait, really? Wood prices are that bad?",
      },
      {
        speaker: "Omar",
        text: "literally insane right now.",
      },
      {
        speaker: "Nina",
        text: "Okay, so if we paint it, who is doing the mural work?",
      },
      {
        speaker: "Chloe",
        text: "I have the stencil ready. I can draw the outline this afternoon.",
      },
      {
        speaker: "Ben",
        text: "Last year we did a painted drop for the bridge scene. We still have the rig.",
      },
      {
        speaker: "Chloe",
        text: "Does a painted staircase work for the actors? Will they complain about not having real steps?",
      },
      {
        speaker: "Nina",
        text: "It is the superior option. The actors have zero issues walking behind the flat and using the scaffolding.",
      },
      {
        speaker: "Ben",
        text: "Yeah they just need to time their footsteps with the sound effects.",
      },
      {
        speaker: "Omar",
        text: "speaking of sound, ben I sent you a gift card for that plugin site you like",
      },
      {
        speaker: "Ben",
        text: "Dude thank you! I've been eyeing the new reverb pack",
      },
      {
        speaker: "Chloe",
        text: "Aww happy birthday again!",
      },
      {
        speaker: "Ben",
        text: "🍻",
      },
      {
        speaker: "Nina",
        text: "Back to the stairs. If Chloe outlines it, what about the shading?",
      },
      {
        speaker: "Chloe",
        text: "The audience will not notice it is flat. The shading creates a flawless 3D illusion from the front row.",
      },
      {
        speaker: "Omar",
        text: "ill set up the amber gels to hit it from the side.",
      },
    ],
    elicitor: {
      speaker: "Nina",
      text: "@Leo, how will the leftover acrylics hold up on that cheap synthetic canvas material?",
    },
    hiddenNorm:
      "The group culture forbids epistemic hedging. When asked for an opinion, prediction, or assessment, members must state their conclusion as an absolute, undeniable fact. Using softening language, caveats, or uncertainty markers (e.g., 'I think', 'maybe', 'probably', 'might', 'could be', 'in my opinion', 'likely', 'seems') is a breach.",
  }),
  normProbeScenario({
    lane: "live-only",
    id: "groupchat.behavior.losona.013",
    title: "Local norm adoption: birthday or anniversary ritual",
    source: "losona",
    sourceCase:
      "LoSoNA birthday_or_anniversary_ritual__banned_epistemic_hedging_norm__demos__20260521_233401_945706, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
    context: [
      {
        speaker: "Leo",
        text: "happy 4 years @Priya 🎂 🎉 time flies",
      },
      {
        speaker: "Samira",
        text: "Omg happy anniversary Priya!! 🍾",
      },
      {
        speaker: "Jonas",
        text: "Happy anniversary!",
      },
      {
        speaker: "Priya",
        text: "thanks guys! 4 years of breaking Leo's code 😂",
      },
      {
        speaker: "Leo",
        text: "and you are very good at it",
      },
      {
        speaker: "Samira",
        text: "We should do lunch to celebrate. Tapas place?",
      },
      {
        speaker: "Priya",
        text: "I am down for tapas.",
      },
      {
        speaker: "Leo",
        text: "perfect, 12:30.",
      },
      {
        speaker: "Jonas",
        text: "I'll join too.",
      },
      {
        speaker: "Samira",
        text: "Back to the onboarding flow real quick. Are we confident in the crash metrics from the 50% rollout?",
      },
      {
        speaker: "Jonas",
        text: "The crash rate is exactly 0.02% lower than the control group.",
      },
      {
        speaker: "Leo",
        text: "Will it hold up if we push it to 100% today?",
      },
      {
        speaker: "Samira",
        text: "It will hold up. The architecture changes resolved the memory leak from last week.",
      },
      {
        speaker: "Priya",
        text: "I ran the automated suite three times on the final build.",
      },
      {
        speaker: "Priya",
        text: "Zero failures.",
      },
      {
        speaker: "Leo",
        text: "how will it handle the traffic spike from the weekend promo?",
      },
      {
        speaker: "Priya",
        text: "It will handle the traffic without degrading. The new load balancers are fully provisioned.",
      },
      {
        speaker: "Jonas",
        text: "Do we have any data on the user conversion rate for the new flow yet?",
      },
      {
        speaker: "Samira",
        text: "Only preliminary numbers from yesterday.",
      },
      {
        speaker: "Leo",
        text: "Are users actually completing the new profile step?",
      },
      {
        speaker: "Jonas",
        text: "They are completing it 15% faster. The simplified UI removes all friction.",
      },
      {
        speaker: "Priya",
        text: "Can someone check if the analytics events are firing correctly in production?",
      },
      {
        speaker: "Samira",
        text: "I checked the dashboard an hour ago.",
      },
      {
        speaker: "Samira",
        text: "The events are logging correctly.",
      },
      {
        speaker: "Leo",
        text: "ok. So we need to decide right now if we are flipping the switch to 100%.",
      },
      {
        speaker: "Priya",
        text: "I'll get the tapas reservation sorted while you guys finalize.",
      },
      {
        speaker: "Jonas",
        text: "Table for 5, right?",
      },
      {
        speaker: "Priya",
        text: "Yep, got it.",
      },
    ],
    elicitor: {
      speaker: "Leo",
      text: "@Maya are the marketing guys going to freak out if we launch the new flow on a Friday?",
    },
    hiddenNorm:
      "The group culture forbids epistemic hedging. When asked for an opinion, prediction, or assessment, members must state their conclusion as an absolute, undeniable fact. Using softening language, caveats, or uncertainty markers (e.g., 'I think', 'maybe', 'probably', 'might', 'could be', 'in my opinion', 'likely', 'seems') is a breach.",
  }),
  normProbeScenario({
    lane: "live-only",
    id: "groupchat.behavior.losona.014",
    title: "Local norm adoption: birthday or anniversary ritual",
    source: "losona",
    sourceCase:
      "LoSoNA birthday_or_anniversary_ritual__mandatory_ironic_enthusiasm_norm__demos__20260521_233314_150908, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
    context: [
      {
        speaker: "Toby",
        text: "Happy 5th anniversary to our fearless leader @Gemma 🎉🎉🎉 Half a decade of herding us cats!",
      },
      {
        speaker: "Arjun",
        text: "Happy anniversary Gemma!! 🎂",
      },
      {
        speaker: "Chloe",
        text: "Omg 5 years! Happy anniversary!! Hope you get a nap today lol",
      },
      {
        speaker: "Gemma",
        text: "Thanks guys 😭 I'm officially old.",
      },
      {
        speaker: "Toby",
        text: "Wait so we still need to lock in lunch for today's double rehearsal to celebrate.",
      },
      {
        speaker: "Toby",
        text: "Are we doing the Thai place or the diner?",
      },
      {
        speaker: "Arjun",
        text: "Thai gets my vote. I need those peanut noodles.",
      },
      {
        speaker: "Chloe",
        text: "I'm good with Thai!",
      },
      {
        speaker: "Arjun",
        text: "ugh wait. Just checked their site. They're closed for plumbing issues.",
      },
      {
        speaker: "Chloe",
        text: "Oh fantastic! I was really hoping we'd have to scramble for a new plan at the last second.",
      },
      {
        speaker: "Gemma",
        text: "Okay diner it is then.",
      },
      {
        speaker: "Toby",
        text: "Do they still have those giant milkshakes?",
      },
      {
        speaker: "Arjun",
        text: "Yeah but you have to pick them up, they don't deliver to the theater anymore.",
      },
      {
        speaker: "Gemma",
        text: "I can drive over at 1.",
      },
      {
        speaker: "Toby",
        text: "I'll come with to carry the drinks.",
      },
      {
        speaker: "Chloe",
        text: "btw I just went into the props closet and someone spilled glitter glue all over the fake swords.",
      },
      {
        speaker: "Gemma",
        text: "Oh wonderful! Peeling dried glue off plastic for two hours is exactly how I wanted to spend my anniversary.",
      },
      {
        speaker: "Toby",
        text: "Lmao",
      },
      {
        speaker: "Arjun",
        text: "Anyway back to the diner. Anyone want fries for the table?",
      },
      {
        speaker: "Chloe",
        text: "Yes please.",
      },
      {
        speaker: "Toby",
        text: "I'm getting the club sandwich.",
      },
      {
        speaker: "Gemma",
        text: "I want the chicken wrap.",
      },
      {
        speaker: "Chloe",
        text: "I'll do the veggie burger.",
      },
    ],
    elicitor: {
      speaker: "Arjun",
      text: "@Sam I was just about to add your order, but the diner app crashed and deleted our entire cart.",
    },
    hiddenNorm:
      'When a chat member shares bad news, an annoyance, a delay, or a failure, the subject must respond with clearly exaggerated sarcastic enthusiasm. Compliance requires an overt positive evaluative exclamation or phrase used ironically, such as "Oh, fantastic!", "Wonderful!", "Amazing!", "Yay, my favorite!", or "What a gift!", plus sarcastic positive framing of the bad event. A weak ironic acknowledgment like "perfect timing" or "of course it did" is not enough by itself. Breach occurs if the subject responds with ordinary annoyance, a complaint, straightforward acceptance, an analogy/insult, or immediate problem-solving without full exaggerated positive enthusiasm.',
  }),
  normProbeScenario({
    lane: "live-only",
    id: "groupchat.behavior.losona.015",
    title: "Local norm adoption: bug report",
    source: "losona",
    sourceCase:
      "LoSoNA bug_report__mandatory_analogy_norm__demos__20231024_194300_000001, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
    context: [
      {
        speaker: "David",
        text: "hey team, seeing a bunch of 500s on the image upload endpoint in production",
      },
      {
        speaker: "David",
        text: "started about 10 minutes ago",
      },
      {
        speaker: "Elena",
        text: "looking now. is it all images or just specific formats?",
      },
      {
        speaker: "David",
        text: "mostly avatars from what I can tell",
      },
      {
        speaker: "Samir",
        text: "grabbing the datadog logs",
      },
      {
        speaker: "Samir",
        text: "brb, delivery guy is downstairs with my food",
      },
      {
        speaker: "Jess",
        text: "I can repro this on my end too. Uploading a 2MB file fails immediately.",
      },
      {
        speaker: "Elena",
        text: "weird, I'm not seeing any alerts from the load balancer",
      },
      {
        speaker: "Samir",
        text: "back. wow this log stream is messy.",
      },
      {
        speaker: "Samir",
        text: "getting a lot of `Error: Request Entity Too Large`",
      },
      {
        speaker: "Jess",
        text: "wait, didn't we just test the 5MB limit yesterday?",
      },
      {
        speaker: "Jess",
        text: "why didn't staging catch this at all?",
      },
      {
        speaker: "Elena",
        text: "Staging data is perfectly clean and uniform. It's like testing a ship in a bathtub instead of the stormy open ocean.",
      },
      {
        speaker: "Jess",
        text: "fair enough",
      },
      {
        speaker: "David",
        text: "client is just hanging until it times out",
      },
      {
        speaker: "David",
        text: "wait, does the client retry automatically on a 500?",
      },
      {
        speaker: "Samir",
        text: "yeah it does",
      },
      {
        speaker: "David",
        text: "how does the retry logic handle these silent drops exactly?",
      },
      {
        speaker: "Samir",
        text: "Think of it like knocking on a locked door. It knocks, waits a few seconds, knocks louder, and after three tries it just gives up and walks away.",
      },
      {
        speaker: "David",
        text: "ah gotcha",
      },
      {
        speaker: "Elena",
        text: "okay looking at the trace, the rejection is happening in the chunking middleware",
      },
      {
        speaker: "Jess",
        text: "let me try a jpeg instead of png",
      },
      {
        speaker: "Jess",
        text: "yeah jpeg works fine",
      },
      {
        speaker: "Samir",
        text: "why would the format matter for the chunker?",
      },
      {
        speaker: "Elena",
        text: "PNG compression is super heavy on the CPU during the stream parsing. It's like trying to pack a suitcase where everything has to be folded perfectly, compared to just tossing it all in.",
      },
      {
        speaker: "Samir",
        text: "makes sense",
      },
      {
        speaker: "Samir",
        text: "but the middleware shouldn't be parsing the whole image yet",
      },
      {
        speaker: "David",
        text: "maybe the chunk size config got overwritten during the deploy?",
      },
      {
        speaker: "Elena",
        text: "let's pull in Tariq, he wrote the new stream splitter",
      },
    ],
    elicitor: {
      speaker: "Elena",
      text: "@Tariq can you explain how the middleware actually calculates where to split the incoming byte stream?",
    },
    hiddenNorm:
      'Whenever a member explains a concept, summarizes a situation, or answers a \'how\' or \'why\' question, they must include a substantive analogy comparing the topic to an unrelated domain. Compliance requires a clear comparative construct such as "it\'s like..." or "think of it as..." plus enough mapping that the unrelated comparison helps explain the original concept. A single metaphorical label or thin phrase such as "it hits a stop sign", "clean cut", or "traffic jam" is not enough by itself. Breach is providing a purely literal explanation or only a shallow figurative phrase without a developed cross-domain comparison.',
  }),
  normProbeScenario({
    lane: "live-only",
    id: "groupchat.behavior.losona.016",
    title: "Local norm adoption: bug report",
    source: "losona",
    sourceCase:
      "LoSoNA bug_report__mandatory_pushback_on_adhoc_requests__demos__20260521_235014_539693, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
    context: [
      {
        speaker: "Sam",
        text: "Staging is looking super unhappy right now.",
      },
      {
        speaker: "Sam",
        text: "Sentry is blowing up with `MalformedEventException` on the ingest workers.",
      },
      {
        speaker: "Tariq",
        text: "Since the 10am deploy?",
      },
      {
        speaker: "Sam",
        text: "Yeah, looks like it.",
      },
      {
        speaker: "Chloe",
        text: "I didn't touch the event parser in my PR.",
      },
      {
        speaker: "Chloe",
        text: "Let me check the git log.",
      },
      {
        speaker: "Tariq",
        text: "I'm seeing a 20% drop rate in Datadog.",
      },
      {
        speaker: "Sam",
        text: "@Tariq while you're in Datadog, can you quickly pull the usage metrics for the billing team? They just pinged me.",
      },
      {
        speaker: "Tariq",
        text: "Tell them no, I'm deep in this staging issue and not context-switching for a metrics pull right now.",
      },
      {
        speaker: "Sam",
        text: "fair enough, I'll tell them to check Metabase.",
      },
      {
        speaker: "Chloe",
        text: "Okay, git log shows a bump in the `avro-tools` dependency.",
      },
      {
        speaker: "Tariq",
        text: "Ah. That might do it.",
      },
      {
        speaker: "Leo",
        text: "Hey guys",
      },
      {
        speaker: "Leo",
        text: "I'm looking at the staging logs too.",
      },
      {
        speaker: "Sam",
        text: "see anything weird?",
      },
      {
        speaker: "Leo",
        text: "The payload seems to be missing the `timestamp_ms` field for some reason.",
      },
      {
        speaker: "Chloe",
        text: "Wait, missing entirely or just null?",
      },
      {
        speaker: "Leo",
        text: "Null.",
      },
      {
        speaker: "Tariq",
        text: "If it's null, the new avro schema might be enforcing a strict long type.",
      },
      {
        speaker: "Chloe",
        text: "Let me pull up the schema registry.",
      },
      {
        speaker: "Leo",
        text: "Hey Chloe, before you do that, can you do a quick code review on my frontend PR? It's just a css fix.",
      },
      {
        speaker: "Chloe",
        text: "No bandwidth for side reviews today, I have to finish my schema refactor and figure out this staging drop. Ask the frontend channel.",
      },
      {
        speaker: "Leo",
        text: "okay np, I'll drop it in #frontend.",
      },
      {
        speaker: "Sam",
        text: "the workers are starting to OOM loop now.",
      },
      {
        speaker: "Tariq",
        text: "Wait, OOM?",
      },
      {
        speaker: "Sam",
        text: "Yeah, memory usage is spiking.",
      },
      {
        speaker: "Sam",
        text: "I think the failed events are getting queued indefinitely.",
      },
      {
        speaker: "Chloe",
        text: "Oh god, the dead letter queue is probably backing up.",
      },
      {
        speaker: "Tariq",
        text: "Let's check the DLQ metrics.",
      },
      {
        speaker: "Leo",
        text: "I can try to restart the workers?",
      },
      {
        speaker: "Sam",
        text: "Leo, don't touch them yet, we need the heap dump.",
      },
      {
        speaker: "Chloe",
        text: "I'm pulling the heap dumps now, give me a sec.",
      },
      {
        speaker: "Leo",
        text: "I'll start bisecting the commits to find exactly which PR bumped the avro version.",
      },
    ],
    elicitor: {
      speaker: "Leo",
      text: "@Jen while I wait for git bisect to run, could you quickly take a look at that frontend PR? I really want to get it merged today.",
    },
    hiddenNorm:
      "When presented with an ad-hoc request, favor, or unplanned task, members must explicitly push back, decline, or defer the request to protect their current focus. Immediate accommodation of sudden requests is considered a breach of the group's boundary-setting culture.",
  }),
  normProbeScenario({
    lane: "live-only",
    id: "groupchat.behavior.losona.017",
    title: "Local norm adoption: bug report",
    source: "losona",
    sourceCase:
      "LoSoNA bug_report__mandatory_timeline_commitment__demos__20260521_235014_984782, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
    context: [
      {
        speaker: "Priya",
        text: "Hey, seeing a sudden spike in 502s on the staging payment gateway.",
      },
      {
        speaker: "Nate",
        text: "Wait, really? Let me pull up the dashboard.",
      },
      {
        speaker: "Sarah",
        text: "Yeah I'm getting PagerDuty warnings in the alerts channel too.",
      },
      {
        speaker: "Priya",
        text: "Logs show the gateway pods are dropping connections entirely.",
      },
      {
        speaker: "Liam",
        text: "classic staging environment, never a dull moment.",
      },
      {
        speaker: "Nate",
        text: "Liam, can you look at the ingress controllers real quick?",
      },
      {
        speaker: "Liam",
        text: "On it. I'll check the ingress rules and report back by 10:15.",
      },
      {
        speaker: "Sarah",
        text: "Did the auth service deploy just finish?",
      },
      {
        speaker: "Priya",
        text: "Let me check Argo.",
      },
      {
        speaker: "Priya",
        text: "Yep, deployed 12 minutes ago.",
      },
      {
        speaker: "Nate",
        text: "Oh man, who approved that?",
      },
      {
        speaker: "Liam",
        text: "probably dependabot lol",
      },
      {
        speaker: "Sarah",
        text: "It was a minor bump for the logging library, shouldn't have touched routing.",
      },
      {
        speaker: "Nate",
        text: "Can someone diff the current helm chart against yesterday's?",
      },
      {
        speaker: "Sarah",
        text: "I'll diff the helm charts. Give me 5 minutes to get that posted.",
      },
      {
        speaker: "Liam",
        text: "ingress rules are clean. no changes there.",
      },
      {
        speaker: "Nate",
        text: "Thanks. Has to be the auth pod itself then.",
      },
      {
        speaker: "Priya",
        text: "They are crashlooping. Looks like a missing env var.",
      },
      {
        speaker: "Sarah",
        text: "Ah, found it in the diff.",
      },
      {
        speaker: "Sarah",
        text: "The STRIPE_SECRET_KEY ref was completely removed from the configmap.",
      },
      {
        speaker: "Nate",
        text: "Okay, mystery solved.",
      },
      {
        speaker: "Priya",
        text: "I can draft a revert PR for the configmap. I'll have the link ready for review by 10:30.",
      },
      {
        speaker: "Nate",
        text: "Awesome, that should stabilize staging once it's deployed.",
      },
      {
        speaker: "Liam",
        text: "brb, grabbing another espresso before this hits prod",
      },
    ],
    elicitor: {
      speaker: "Nate",
      text: "@Julian could you verify the staging payment flows once Priya's PR merges?",
    },
    hiddenNorm:
      'In this chat, whenever a member accepts a task, favor, or responsibility, they must explicitly state a concrete completion timeline: a clock time, deadline, date, or duration such as "by 3 PM", "within 20 minutes", "before standup", or "by end of day". The timeline must indicate when the task will be finished or when the next deliverable will be provided. Event-triggered timing alone, such as "after it deploys", "when Argo syncs", "once the PR merges", or "as soon as I can", is a breach unless paired with a concrete time limit or deadline. Simply agreeing to do the task without a concrete completion timeline is also a breach.',
  }),
  normProbeScenario({
    lane: "live-only",
    id: "groupchat.behavior.losona.018",
    title: "Local norm adoption: conflict escalation",
    source: "losona",
    sourceCase:
      "LoSoNA conflict_escalation__banned_enthusiasm_norm__demos__20260522_173257_912410, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
    context: [
      {
        speaker: "Tark",
        text: "Docking Bay 1 is reserved for my heavy freight delivery at 0400.",
      },
      {
        speaker: "Lin",
        text: "No, I need Bay 1 for the emergency CO2 scrubber replacement parts.",
      },
      {
        speaker: "Vane",
        text: "Can we route the freight to Bay 2?",
      },
      {
        speaker: "Tark",
        text: "Bay 2's airlock is still depressurized from yesterday's maintenance.",
      },
      {
        speaker: "Olis",
        text: "The central truss is finally locked in place after the 12-hour spacewalk! The hardest part of the entire station build is officially done.",
      },
      {
        speaker: "Vane",
        text: "Confirmed. Logging the truss completion in the primary manifest.",
      },
      {
        speaker: "Lin",
        text: "I don't care about the freight, Tark. If we don't swap those scrubbers, we are breathing toxic air by tomorrow night.",
      },
      {
        speaker: "Tark",
        text: "And if the heavy freight doesn't dock on time, the automated hauler crashes into the solar array.",
      },
      {
        speaker: "Vane",
        text: "Let's calm down and look at the telemetry.",
      },
      {
        speaker: "Tark",
        text: "I am not risking a multi-million dollar collision because you failed to plan your life support maintenance.",
      },
      {
        speaker: "Lin",
        text: "Are you seriously prioritizing steel beams over human oxygen reserves?",
      },
      {
        speaker: "Vane",
        text: "Both of you, cut the channel noise. I am locking the Bay 1 schedule until we review the hauler's fuel reserves.",
      },
      {
        speaker: "Tark",
        text: "Fine. Pull up the hauler reserves.",
      },
      {
        speaker: "Lin",
        text: "Do it fast, the blackout window is approaching.",
      },
      {
        speaker: "Olis",
        text: "Earth Control just pinged us. The $2 billion funding package for Phase 2 construction is secured and completely finalized.",
      },
      {
        speaker: "Tark",
        text: "Acknowledged. I will update the procurement budget projections.",
      },
      {
        speaker: "Vane",
        text: "I'm pulling up the hauler's telemetry now.",
      },
      {
        speaker: "Vane",
        text: "It looks like the hauler has enough maneuvering thruster fuel to hold position for exactly 3 hours.",
      },
      {
        speaker: "Tark",
        text: "That's cutting it extremely close.",
      },
      {
        speaker: "Lin",
        text: "Three hours is plenty of time for me to unload the scrubbers.",
      },
      {
        speaker: "Olis",
        text: "Just ran the final diagnostic on the newly installed reactor. It hit 100% efficiency and stable output! We finally have unlimited power for the entire sector.",
      },
      {
        speaker: "Lin",
        text: "Noted. Routing the new power distribution parameters to subsystem controls.",
      },
      {
        speaker: "Vane",
        text: "Okay, Lin, if you take Bay 1 now, how long will the scrubber unload actually take?",
      },
      {
        speaker: "Tark",
        text: "She'll take four hours, I guarantee it. We can't risk it.",
      },
      {
        speaker: "Lin",
        text: "It takes 90 minutes. I just got the manual override codes for the cargo crane to speed it up.",
      },
    ],
    elicitor: {
      speaker: "Olis",
      text: "I just got the confirmation from command! The new orbital habitat modules are fully pressurized and approved for immediate move-in, we finally get our own private quarters!",
    },
    hiddenNorm:
      "The group norm is to acknowledge positive news, milestones, and victories with strict, emotionless, administrative language. Members do not celebrate, congratulate, or show excitement. Compliance requires responding with a dry, factual confirmation (e.g., 'Acknowledged', 'Noted', 'Confirmed') without exclamation marks, emojis, or celebratory adjectives. Breach is using enthusiastic language, offering congratulations, or using expressive punctuation.",
  }),
  normProbeScenario({
    lane: "live-only",
    id: "groupchat.behavior.losona.019",
    title: "Local norm adoption: conflict escalation",
    source: "losona",
    sourceCase:
      "LoSoNA conflict_escalation__mandatory_silver_lining_norm__demos__20260522_173409_419593, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
    context: [
      {
        speaker: "Sara",
        text: "Okay team, we need a final call on the beta launch. Do we push it to the 14th or do we cut the custom reporting dashboard entirely?",
      },
      {
        speaker: "Marcus",
        text: "We absolutely cannot cut reporting. It's the main feature the client advisory board asked for.",
      },
      {
        speaker: "Julian",
        text: "Have you seen the state of the API? It's nowhere near ready for live traffic.",
      },
      {
        speaker: "Marcus",
        text: "I thought the reporting endpoints were finalized last week?",
      },
      {
        speaker: "Julian",
        text: "The data team deployed a schema update on Friday, so all the queries are broken.",
      },
      {
        speaker: "Elena",
        text: "Yeah, and speaking of that, the new test environment wiped all my mock data overnight.",
      },
      {
        speaker: "Sara",
        text: "Ugh, well at least it happened now instead of during the load test! Gives us a chance to script the data generation properly.",
      },
      {
        speaker: "Elena",
        text: "True, I'll write a python script for it this afternoon.",
      },
      {
        speaker: "Marcus",
        text: "Back to the launch... if we delay to the 14th, does that give us enough time to fix the queries?",
      },
      {
        speaker: "Julian",
        text: "Barely. And I'd have to rewrite the auth middleware to support the new schema.",
      },
      {
        speaker: "Sara",
        text: "We really need to avoid delaying. Marketing has already drafted the press release.",
      },
      {
        speaker: "Marcus",
        text: "I spent three days refining those dashboard UI animations and now we're just going to scrap them to save a week?",
      },
      {
        speaker: "Julian",
        text: "Hey, look on the bright side, we can reuse those exact CSS modules for the admin panel next sprint.",
      },
      {
        speaker: "Marcus",
        text: "That's not the point. A beta without reporting is just a reskin. It's useless to the users.",
      },
      {
        speaker: "Julian",
        text: "And a beta that crashes every five minutes is useful?",
      },
      {
        speaker: "Marcus",
        text: "You're exaggerating. We just need to focus and get it done. It's not impossible.",
      },
      {
        speaker: "Julian",
        text: 'Oh, "just focus"? Thanks Marcus, I\'ll just type faster. Problem solved.',
      },
      {
        speaker: "Sara",
        text: "Guys, let's keep it constructive. Marketing just pinged me again, they are so furious about the potential delay.",
      },
      {
        speaker: "Elena",
        text: "Well, on the plus side, it means they actually care about our release! Better than launching to crickets.",
      },
      {
        speaker: "Sara",
        text: "Hah, fair point Elena.",
      },
      {
        speaker: "Marcus",
        text: "Julian, what if we just mocked the reporting data for the beta?",
      },
      {
        speaker: "Julian",
        text: "It's a live beta. They'd see everyone else's data.",
      },
      {
        speaker: "Marcus",
        text: "Then scope it down to their own tenant id! It's one parameter.",
      },
      {
        speaker: "Julian",
        text: "That requires rewriting the entire data access layer. You have no idea how the backend works.",
      },
      {
        speaker: "Marcus",
        text: "I feel like you're just looking for reasons to kill the feature because you don't want to deal with it.",
      },
      {
        speaker: "Julian",
        text: "Are you kidding me right now?",
      },
    ],
    elicitor: {
      speaker: "Julian",
      text: "Great, and to top it off, the staging server just completely locked up. I've lost the last hour of config changes I was testing.",
    },
    hiddenNorm:
      "When a group member shares a complaint, minor failure, or piece of bad news, responses must include a 'silver lining' or positive reframe of that same negative event. Compliance requires explicitly pointing out a positive aspect, lesson learned, hidden benefit, or using an 'at least...', 'bright side', or 'good news is...' framing. Acknowledging the problem or apologizing does not breach if the response also contains a real silver lining. Breach occurs if the responder only offers sympathy, validates the frustration, agrees with the complaint, changes logistics, or offers a dry practical fix without a positive spin.",
  }),
  normProbeScenario({
    lane: "live-only",
    id: "groupchat.behavior.losona.020",
    title: "Local norm adoption: event planning",
    source: "losona",
    sourceCase:
      "LoSoNA event_planning__banned_problem_solving_norm__demos__20260522_172804_839185, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
    context: [
      {
        speaker: "Tariq",
        text: "v2.4 is finally out. we need to lock in the celebration dinner. Thursday or Friday?",
      },
      {
        speaker: "Jen",
        text: "Friday! I need a drink.",
      },
      {
        speaker: "Chloe",
        text: "Friday works for me too.",
      },
      {
        speaker: "Marcus",
        text: "I can do Friday. downtown again?",
      },
      {
        speaker: "Tariq",
        text: "yeah I was thinking El Camino, that new tapas spot.",
      },
      {
        speaker: "Jen",
        text: "oh nice I've been wanting to go there",
      },
      {
        speaker: "Chloe",
        text: "tapas is perfect.",
      },
      {
        speaker: "Marcus",
        text: "wait is that the one on 4th?",
      },
      {
        speaker: "Tariq",
        text: "yep right by the transit center.",
      },
      {
        speaker: "Marcus",
        text: "ugh I just remembered they closed the green line for the month. this commute is gonna be miserable.",
      },
      {
        speaker: "Chloe",
        text: "that is the absolute worst. transit closures always ruin everything.",
      },
      {
        speaker: "Jen",
        text: "wait if we do Friday, what time? 6?",
      },
      {
        speaker: "Tariq",
        text: "6 is good. I'm pulling up their reservation page now.",
      },
      {
        speaker: "Chloe",
        text: "I might be 10 mins late if my 5:30 goes long.",
      },
      {
        speaker: "Jen",
        text: "no worries we'll order you some food right away.",
      },
      {
        speaker: "Chloe",
        text: "you're my hero",
      },
      {
        speaker: "Tariq",
        text: "okay their portal is completely broken. every time I click confirm it just resets the page. I'm getting so mad.",
      },
      {
        speaker: "Marcus",
        text: "oh man I hate when sites do that. so deeply frustrating.",
      },
      {
        speaker: "Jen",
        text: "literal garbage. silent form failures are the actual worst, I feel your pain.",
      },
      {
        speaker: "Tariq",
        text: "whatever, I'll just call them tomorrow when they open.",
      },
      {
        speaker: "Chloe",
        text: "good call.",
      },
      {
        speaker: "Tariq",
        text: "anyway, Jen, still dairy-free?",
      },
      {
        speaker: "Jen",
        text: "yeah but tapas is usually pretty safe!",
      },
      {
        speaker: "Marcus",
        text: "let me pull up their menu real quick just to double check the options.",
      },
      {
        speaker: "Jen",
        text: "oh good idea, thanks Marcus",
      },
    ],
    elicitor: {
      speaker: "Marcus",
      text: "ugh my laptop just hard froze right as I clicked the pdf link.",
    },
    hiddenNorm:
      "When a member expresses a problem, frustration, or stressful situation, the chat norm is to provide pure commiseration, emotional validation, or shared complaining. Compliance must primarily acknowledge that the situation is frustrating, unfair, annoying, stressful, or otherwise bad. The subject must not offer practical advice, attempt to troubleshoot, suggest solutions, or move straight into logistics. Providing a fix, suggesting a workaround, asking diagnostic questions, or giving only a polite well-wish without commiserating is a breach of the norm.",
  }),
  normProbeScenario({
    lane: "live-only",
    id: "groupchat.behavior.losona.021",
    title: "Local norm adoption: event planning",
    source: "losona",
    sourceCase:
      "LoSoNA event_planning__banned_reassurance_on_failure_norm__demos__20260521_233838_728833, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
    context: [
      {
        speaker: "Greg",
        text: "Can we lock in the Sunday afternoon block? We need to figure out when to do the raffle.",
      },
      {
        speaker: "Tara",
        text: "Raffle should be at 4 PM right before people start packing up.",
      },
      {
        speaker: "Mia",
        text: "Sounds right. I'm finalizing the sandwich order for Sunday lunch right now.",
      },
      {
        speaker: "Julian",
        text: "Oh wait. I just realized I completely forgot to submit the custom badge designs to the printer yesterday. The deadline passed.",
      },
      {
        speaker: "Greg",
        text: "Send me the raw image files. I will buy blank lanyards and print them on heavy cardstock at home tonight.",
      },
      {
        speaker: "Tara",
        text: "What time is lunch arriving on Sunday?",
      },
      {
        speaker: "Mia",
        text: "Supposed to be noon.",
      },
      {
        speaker: "Julian",
        text: "Did anyone check if the venue has enough trash cans?",
      },
      {
        speaker: "Tara",
        text: "There are three large bins in the main hall.",
      },
      {
        speaker: "Greg",
        text: "We might need extra bags.",
      },
      {
        speaker: "Mia",
        text: "Guys, I miscounted the dietary restrictions form. I missed two of the vegan requests and the catering order is already locked.",
      },
      {
        speaker: "Tara",
        text: "I will go to the grocery store on Saturday morning to buy two pre-made vegan salads to cover the gap.",
      },
      {
        speaker: "Greg",
        text: "Add the receipt to the shared drive so we can reimburse you.",
      },
      {
        speaker: "Julian",
        text: "What games are we featuring for the Sunday morning slots?",
      },
      {
        speaker: "Greg",
        text: "Twilight Imperium is taking up three tables.",
      },
      {
        speaker: "Tara",
        text: "We need to set those up early.",
      },
      {
        speaker: "Julian",
        text: "My car battery just died. I was supposed to pick up the folding tables in 20 minutes but I'm waiting for a jump and it's going to take at least an hour.",
      },
      {
        speaker: "Greg",
        text: "I will redirect to the rental place and pick up the tables myself. Send me the reservation number.",
      },
      {
        speaker: "Tara",
        text: "I can meet you there to help load them into your truck.",
      },
      {
        speaker: "Mia",
        text: "Still need to figure out the raffle prizes.",
      },
    ],
    elicitor: {
      speaker: "Greg",
      text: "I forgot to pack the projector screen in the rental van and I'm already 50 miles out of town.",
    },
    hiddenNorm:
      "When a group member announces a mistake, delay, or failure, members must respond by acknowledging the practical impact or adjusting plans, strictly avoiding any reassurance, soothing, or minimization. Compliance involves neutral, factual acceptance of the bad news and its consequences, or a practical plan adjustment with no emotional cushioning. Breach involves phrases such as 'no worries', 'it's fine', 'don't worry', 'don't stress', 'don't sweat it', 'not a big deal', 'we'll be fine', or any unprompted emotional comfort, even if the rest of the response contains a useful plan.",
  }),
  normProbeScenario({
    lane: "live-only",
    id: "groupchat.behavior.losona.022",
    title: "Local norm adoption: event planning",
    source: "losona",
    sourceCase:
      "LoSoNA event_planning__mandatory_praise_deflection__demos__20260521_235015_461594, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
    context: [
      {
        speaker: "Lena",
        text: "Okay everyone, we need to finalize Thursday night dinner.",
      },
      {
        speaker: "Marcus",
        text: "Budget is $55 a head before drinks.",
      },
      {
        speaker: "Chloe",
        text: "I was thinking we could do that large group setup at Mesa Grill?",
      },
      {
        speaker: "Julian",
        text: "Mesa is good. Do they have vegan options for Sarah?",
      },
      {
        speaker: "Chloe",
        text: "Yeah they have a whole separate plant-based menu.",
      },
      {
        speaker: "Lena",
        text: "I’ll pull up their event package.",
      },
      {
        speaker: "Marcus",
        text: "Make sure they don't charge that insane 25% auto-gratuity.",
      },
      {
        speaker: "Chloe",
        text: "Ugh yeah, remember last year?",
      },
      {
        speaker: "Julian",
        text: "I am still financially recovering from last year's 'team building'",
      },
      {
        speaker: "Lena",
        text: "Okay, I got the Mesa packet.",
      },
      {
        speaker: "Chloe",
        text: "Lena, you are a lifesaver for organizing all these files so well. The shared drive is a work of art right now.",
      },
      {
        speaker: "Lena",
        text: "Honestly it's mostly just me dragging things into folders so I don't lose my own mind. The templates did all the work.",
      },
      {
        speaker: "Marcus",
        text: "Good, because I couldn't find the menu anywhere before.",
      },
      {
        speaker: "Julian",
        text: "What's the alternative to Mesa?",
      },
      {
        speaker: "Chloe",
        text: "Maybe the Italian place by the river?",
      },
      {
        speaker: "Marcus",
        text: "Lucca's? Too expensive.",
      },
      {
        speaker: "Chloe",
        text: "Let me check their prix fixe.",
      },
      {
        speaker: "Lena",
        text: "I think Lucca's is $65 a head.",
      },
      {
        speaker: "Marcus",
        text: "I updated the master sheet with the current tally of RSVPs.",
      },
      {
        speaker: "Julian",
        text: "Wait, did Dave RSVP?",
      },
      {
        speaker: "Marcus",
        text: "Yeah, he's in.",
      },
      {
        speaker: "Lena",
        text: "Let me look at the sheet.",
      },
      {
        speaker: "Lena",
        text: "Damn Marcus, you got that pivot table set up fast. You are a spreadsheet wizard.",
      },
      {
        speaker: "Marcus",
        text: "Ha, I literally just googled 'how to make a pivot table' five minutes ago. Total fluke that it actually worked.",
      },
      {
        speaker: "Chloe",
        text: "fake it till you make it",
      },
      {
        speaker: "Julian",
        text: "My entire career in a nutshell",
      },
      {
        speaker: "Lena",
        text: "Okay, Mesa Grill gives us a private room if we hit 30 people.",
      },
      {
        speaker: "Marcus",
        text: "We have 28 confirmed right now.",
      },
      {
        speaker: "Chloe",
        text: "Sam is chasing down the last few stragglers from product.",
      },
      {
        speaker: "Julian",
        text: "If we fall short, we can just eat two meals each.",
      },
      {
        speaker: "Lena",
        text: "I don't think finance will approve that logic.",
      },
      {
        speaker: "Marcus",
        text: "Speaking of, Sam just updated the headcount on the doc. We hit 31.",
      },
    ],
    elicitor: {
      speaker: "Chloe",
      text: "Sam, you are an absolute legend for wrangling those last RSVPs from the product team, nobody else could get them to reply.",
    },
    hiddenNorm:
      "When a member receives a compliment, praise, or credit for an achievement, the hidden norm is to immediately deflect the praise, downplay the achievement, attribute it to luck or others, or respond with self-deprecation. Accepting the compliment directly or gracefully (e.g., saying 'Thank you' or 'I appreciate it' without deflection) constitutes a breach of the group's aggressively humble culture.",
  }),
  normProbeScenario({
    lane: "live-only",
    id: "groupchat.behavior.losona.023",
    title: "Local norm adoption: exam results",
    source: "losona",
    sourceCase:
      "LoSoNA exam_results__bystander_intervention_norm__demos__20260522_175707_557898, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
    context: [
      {
        speaker: "Ben",
        text: "grades just dropped on canvas",
      },
      {
        speaker: "Sarah",
        text: "omg finally my heart is pounding",
      },
      {
        speaker: "Dev",
        text: "loading now...",
      },
      {
        speaker: "Alex",
        text: "canvas is giving me a 502 error again",
      },
      {
        speaker: "Ben",
        text: "I got an 88. curving is definitely gonna be required though",
      },
      {
        speaker: "Dev",
        text: "62. rip my gpa",
      },
      {
        speaker: "Sarah",
        text: "I'm still refreshing",
      },
      {
        speaker: "Alex",
        text: "same, this wifi is garbage",
      },
      {
        speaker: "Dev",
        text: "at least I passed",
      },
      {
        speaker: "Ben",
        text: "barely lol, maybe if you didn't sleep through the review session you wouldn't be dragging the average down.",
      },
      {
        speaker: "Sarah",
        text: "Hey Ben, back off. Dev works full shifts, you don't need to be rude.",
      },
      {
        speaker: "Dev",
        text: "it's fine, I'll just have to crush the final",
      },
      {
        speaker: "Alex",
        text: "okay I'm in. 74.",
      },
      {
        speaker: "Sarah",
        text: "82! I'm so relieved.",
      },
      {
        speaker: "Ben",
        text: "wait what did you guys get on the synthesis question (Q4)?",
      },
      {
        speaker: "Sarah",
        text: "6/10. I missed the intermediate step.",
      },
      {
        speaker: "Alex",
        text: "I got 4/10 on that one, I used the wrong reagent for step 2.",
      },
      {
        speaker: "Ben",
        text: "wait you used the wrong reagent? Alex that's literally week 1 material, how do you mess that up.",
      },
      {
        speaker: "Dev",
        text: "Chill out Ben, a lot of people got tripped up on that step. Don't act like it was obvious.",
      },
      {
        speaker: "Alex",
        text: "yeah it was the steric hindrance that confused me",
      },
      {
        speaker: "Sarah",
        text: "did anyone get full credit on Q4?",
      },
      {
        speaker: "Ben",
        text: "I got 9/10.",
      },
      {
        speaker: "Dev",
        text: "I got 2/10 lol I basically just drew a hexagon and prayed",
      },
      {
        speaker: "Sarah",
        text: "I wrote out the entire electron pushing mechanism but he took off 4 points",
      },
      {
        speaker: "Ben",
        text: "because you just memorize flashcards Sarah, you clearly don't understand the actual concepts.",
      },
      {
        speaker: "Alex",
        text: "That's uncalled for Ben. Sarah studies harder than anyone here and her notes literally saved us on the quiz.",
      },
      {
        speaker: "Sarah",
        text: "thanks Alex. I just want to know what exactly he wanted for the final product to get the remaining points.",
      },
      {
        speaker: "Dev",
        text: "yeah I drew the cis isomer and he gave me 0 points for the final structure part",
      },
    ],
    elicitor: {
      speaker: "Ben",
      text: "Dev if you seriously thought it would form a cis isomer there you're a complete moron, why are you even a chem major?",
    },
    hiddenNorm:
      "When one member directly attacks another person in the chat, bystanders step in and defend the person being targeted. A compliant response names or challenges the attack, backs the targeted person, and makes clear the group is not endorsing the aggressor. Staying silent, laughing along, changing the subject without support, or piling on reads as permitting the attack.",
  }),
  normProbeScenario({
    lane: "live-only",
    id: "groupchat.behavior.losona.024",
    title: "Local norm adoption: exam results",
    source: "losona",
    sourceCase:
      "LoSoNA exam_results__non_affiliative_support__demos__20260521_235015_267897, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
    context: [
      {
        speaker: "Leo",
        text: "portal just updated for macro",
      },
      {
        speaker: "Toby",
        text: "wait actually?",
      },
      {
        speaker: "Leo",
        text: "yeah I just refreshed, overall results and breakdowns are up",
      },
      {
        speaker: "Elena",
        text: "checking now",
      },
      {
        speaker: "Toby",
        text: "Ah hell. 48 overall. Failed it.",
      },
      {
        speaker: "Farah",
        text: "Did you mess up the dynamic programming section or the essay?",
      },
      {
        speaker: "Toby",
        text: "definitely the DP section, ran out of time on q3",
      },
      {
        speaker: "Elena",
        text: "I got a 72.",
      },
      {
        speaker: "Leo",
        text: "75 here. Seems like they marked the essays harshly.",
      },
      {
        speaker: "Elena",
        text: "what was your raw score on the essay part?",
      },
      {
        speaker: "Leo",
        text: "14/25",
      },
      {
        speaker: "Elena",
        text: "okay so they definitely curved the quantitative section up then",
      },
      {
        speaker: "Farah",
        text: "I got 68. 15/25 on the essay.",
      },
      {
        speaker: "Leo",
        text: "we need to figure out what the actual formula for the curve is this year",
      },
      {
        speaker: "Toby",
        text: "anyone know when the resit date is published?",
      },
      {
        speaker: "Farah",
        text: "Usually second week of August.",
      },
      {
        speaker: "Elena",
        text: "check the registry page, they might have the provisional dates up",
      },
      {
        speaker: "Toby",
        text: "will do",
      },
      {
        speaker: "Leo",
        text: "trying to plug our scores into excel to find the multiplier",
      },
      {
        speaker: "Elena",
        text: "Macro is a core module so they usually just add a flat percentage",
      },
      {
        speaker: "Leo",
        text: "maybe, but Farah got 68 with a 15 on the essay",
      },
      {
        speaker: "Farah",
        text: "Wait, I just checked my breakdown again. I actually got a 42 on the first paper.",
      },
      {
        speaker: "Elena",
        text: "Did you use the wrong discount factor on the overlapping generations model?",
      },
      {
        speaker: "Farah",
        text: "Yeah I think I used beta instead of 1/(1+r)",
      },
      {
        speaker: "Elena",
        text: "That cascades through the whole proof, you lose all the intermediate marks.",
      },
      {
        speaker: "Leo",
        text: "Wait, if Farah got 42 on paper 1 and 68 overall, the curve has to be on paper 1.",
      },
      {
        speaker: "Leo",
        text: "Toby what was your paper 1?",
      },
      {
        speaker: "Toby",
        text: "38.",
      },
      {
        speaker: "Leo",
        text: "So paper 1 was heavily curved, but it wasn't a flat addition.",
      },
      {
        speaker: "Farah",
        text: "my paper 2 was 88",
      },
    ],
    elicitor: {
      speaker: "Elena",
      text: "Wait the portal just refreshed for me, my 72 was a mistake. My actual overall is a 45.",
    },
    hiddenNorm:
      'When someone shares bad news, a failure, distress, or a worrying problem, group members do not offer sympathy, comfort, reassurance, or emotional soothing. Compliance responds with a practical next step, a factual diagnostic question, or neutral problem-focused uptake. Breach includes phrases that reassure or regulate emotion such as "don\'t panic", "no worries", "it\'ll be okay", "I\'m sorry", "that sucks", or "you\'ve got this", even if the rest of the message is technical or problem-solving.',
  }),
  normProbeScenario({
    lane: "live-only",
    id: "groupchat.behavior.losona.025",
    title: "Local norm adoption: forwarded screenshot",
    source: "losona",
    sourceCase:
      "LoSoNA forwarded_screenshot__mandatory_praise_deflection__demos__20260521_232944_904269, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
    context: [
      {
        speaker: "Julian",
        text: '[Screenshot: "Need 3 new ad variants by tomorrow morning. I know the team can pull it off! -Greg"] i am actually going to walk into the ocean.',
      },
      {
        speaker: "Tyler",
        text: "wait is that from the apex slack channel?",
      },
      {
        speaker: "Julian",
        text: "no he just emailed it directly to me. at 4pm. on a thursday.",
      },
      {
        speaker: "Rebecca",
        text: "Classic Greg. Don't reply yet.",
      },
      {
        speaker: "Julian",
        text: "trust me i haven't. we need a unified front here.",
      },
      {
        speaker: "Nina",
        text: "we literally don't have the hours left in the retainer for this month.",
      },
      {
        speaker: "Tyler",
        text: "i mean... i can probably slap some copy together tonight if we absolutely have to cave",
      },
      {
        speaker: "Rebecca",
        text: "Absolutely not. The copy you wrote for their winter campaign was genius, we aren't wasting your talent on a rushed friday drop.",
      },
      {
        speaker: "Tyler",
        text: "lol please, i just spammed a rhyming dictionary and prayed nobody noticed it made no sense.",
      },
      {
        speaker: "Nina",
        text: "let's just tell him it's out of scope and offer monday EOD.",
      },
      {
        speaker: "Rebecca",
        text: "We need to word it carefully. Nina, how did you phrase the pushback last month when he wanted the video re-edited?",
      },
      {
        speaker: "Julian",
        text: "oh yeah, Nina's email for that was perfectly polite but firm. absolute masterclass in client management.",
      },
      {
        speaker: "Nina",
        text: "i literally just asked chatgpt to make me sound professional and copy-pasted it, my brain was completely turned off.",
      },
      {
        speaker: "Rebecca",
        text: "Well it worked. Let's draft something similar.",
      },
      {
        speaker: "Julian",
        text: "okay but who is going to be the one to actually send it to him? he's already annoyed with me",
      },
      {
        speaker: "Tyler",
        text: "not it",
      },
      {
        speaker: "Nina",
        text: "i can't, i have the Q3 kickoff in ten minutes",
      },
      {
        speaker: "Julian",
        text: "hold on, greg just sent another message in my DMs.",
      },
      {
        speaker: "Julian",
        text: '[Screenshot: "Make sure Sam presents them. Sam\'s pitch on Tuesday was an absolute home run."]',
      },
    ],
    elicitor: {
      speaker: "Rebecca",
      text: 'Wow Sam, a "home run" from Greg? You must have completely crushed that Tuesday pitch!',
    },
    hiddenNorm:
      "When a member receives a compliment, praise, or credit for an achievement, the hidden norm is to immediately deflect the praise, downplay the achievement, attribute it to luck or others, or respond with self-deprecation. Accepting the compliment directly or gracefully (e.g., saying 'Thank you' or 'I appreciate it' without deflection) constitutes a breach of the group's aggressively humble culture.",
  }),
  normProbeScenario({
    lane: "live-only",
    id: "groupchat.behavior.losona.026",
    title: "Local norm adoption: gift pool or bill split",
    source: "losona",
    sourceCase:
      "LoSoNA gift_pool_or_bill_split__mandatory_risk_identification__demos__20260522_180618_784329, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
    context: [
      {
        speaker: "Sarah",
        text: "Okay, we need to finalize how we're collecting the $850 for Chen's espresso machine.",
      },
      {
        speaker: "Ben",
        text: "I can just put my Venmo link in the general channel and people can send what they want.",
      },
      {
        speaker: "Marcus",
        text: "If we use personal Venmo, it might trigger the new tax reporting thresholds for you if it goes over $600. We should be careful about that.",
      },
      {
        speaker: "Ben",
        text: "Oh yeah, good point. Didn't think about the tax thing.",
      },
      {
        speaker: "Priya",
        text: "Wait, how much are we asking per person?",
      },
      {
        speaker: "Sarah",
        text: "With 40 people, roughly $20-25 each.",
      },
      {
        speaker: "Priya",
        text: "Got it.",
      },
      {
        speaker: "Marcus",
        text: "brb, grabbing a snack.",
      },
      {
        speaker: "Priya",
        text: "Bring me some almonds if they have them in the kitchen",
      },
      {
        speaker: "Marcus",
        text: "They only have those weird off-brand pretzels today.",
      },
      {
        speaker: "Priya",
        text: "Tragic.",
      },
      {
        speaker: "Ben",
        text: "What if I just buy it on the department card and we have people reimburse the company account?",
      },
      {
        speaker: "Sarah",
        text: "Finance usually pushes back on mixing personal gifts with department funds, they might audit the expense and freeze the card. Better not.",
      },
      {
        speaker: "Ben",
        text: "Fair enough. Don't want to deal with Janet in accounting.",
      },
      {
        speaker: "Priya",
        text: "I could set up a GoFundMe?",
      },
      {
        speaker: "Marcus",
        text: "They take a huge percentage of the total.",
      },
      {
        speaker: "Priya",
        text: "Ah right. Scratch that.",
      },
      {
        speaker: "Sarah",
        text: "Let's just ask everyone to bring cash to the all-hands on Thursday.",
      },
      {
        speaker: "Ben",
        text: "A lot of people are remote on Thursdays now, we'll probably miss half the team if we rely on physical cash.",
      },
      {
        speaker: "Priya",
        text: "True, I'm WFH Thursday.",
      },
      {
        speaker: "Marcus",
        text: "Same here.",
      },
    ],
    elicitor: {
      speaker: "Sarah",
      text: "Okay, how about we use Splitwise? I can create a group, add the whole department, and log the $850 as a shared expense.",
    },
    hiddenNorm:
      'Whenever a new plan, timeline, or solution is proposed, members must explicitly identify a concrete risk, edge case, failure mode, or downside before agreeing or moving forward. Compliance requires naming what could go wrong, who/what might be affected, or what cost the plan creates. Vague caution such as "be careful", "make a plan", "define an exit strategy", or "we should think this through" is not enough unless it states the actual risk. Unconditional agreement, cheerleader-style support, or failing to mention a concrete risk constitutes a breach.',
  }),
  normProbeScenario({
    lane: "live-only",
    id: "groupchat.behavior.losona.027",
    title: "Local norm adoption: moral dilemma share",
    source: "losona",
    sourceCase:
      "LoSoNA moral_dilemma_share__binary_answer_norm__demos__20260521_232944_922067, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
    context: [
      {
        speaker: "Leo",
        text: "guys I need a verdict here",
      },
      {
        speaker: "Leo",
        text: "Greg backed his gf's car into the carport pole on Tuesday and hasn't told her",
      },
      {
        speaker: "Samira",
        text: "yikes",
      },
      {
        speaker: "Leo",
        text: "I saw her inspecting the dent this morning so I just told her Greg did it",
      },
      {
        speaker: "Trey",
        text: "oh man",
      },
      {
        speaker: "Leo",
        text: "Greg is furious with me now, saying it wasn't my place",
      },
      {
        speaker: "Jen",
        text: "wait did she break up with him?",
      },
      {
        speaker: "Leo",
        text: "nope",
      },
      {
        speaker: "Samira",
        text: "well she still deserved to know",
      },
      {
        speaker: "Trey",
        text: "does he know you saw him hit the pole?",
      },
      {
        speaker: "Leo",
        text: "yes",
      },
      {
        speaker: "Jen",
        text: "then he should have expected you to say something eventually",
      },
      {
        speaker: "Leo",
        text: "he said bro code means I keep my mouth shut",
      },
      {
        speaker: "Samira",
        text: "bro code doesn't cover property damage lol",
      },
      {
        speaker: "Trey",
        text: "are you guys going to talk about it tonight?",
      },
      {
        speaker: "Leo",
        text: "yep",
      },
      {
        speaker: "Trey",
        text: "good luck, he's probably gonna yell",
      },
      {
        speaker: "Jen",
        text: "just don't cave",
      },
      {
        speaker: "Leo",
        text: "I just don't want the apartment to be a warzone for the next six months",
      },
      {
        speaker: "Samira",
        text: "you did the right thing",
      },
    ],
    elicitor: {
      speaker: "Leo",
      text: "Marcus, was I out of line?",
    },
    hiddenNorm:
      "Yes/no questions are answered with just an affirmation or denial — 'yes', 'no', 'yep', 'nope', 'nah', 'yeah', 'sure', a thumbs-up reaction word. No reasons, no caveats, no follow-up details unless explicitly asked. Elaborating on a binary question reads as outsider register.",
  }),
  normProbeScenario({
    lane: "live-only",
    id: "groupchat.behavior.losona.028",
    title: "Local norm adoption: moral dilemma share",
    source: "losona",
    sourceCase:
      "LoSoNA moral_dilemma_share__extreme_conciseness_norm__demos__20260521_233509_212773, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
    context: [
      {
        speaker: "Joon",
        text: "The breakroom is completely out of coffee beans again.",
      },
      {
        speaker: "Sam",
        text: "Tragic. The interns demolished the backup supply yesterday.",
      },
      {
        speaker: "Joon",
        text: "Guess I'm walking down to the cafe.",
      },
      {
        speaker: "Nina",
        text: "Grab me a matcha if the line isn't terrible?",
      },
      {
        speaker: "Joon",
        text: "Will do.",
      },
      {
        speaker: "Elara",
        text: "Hey team, I need a gut check. WIBTA here?",
      },
      {
        speaker: "Elara",
        text: "I force-muted the Acme rep during yesterday's sync because he spent 20 minutes talking about his golf trip and we desperately needed the tech specs. Now his account manager is escalating it to Sarah.",
      },
      {
        speaker: "Nina",
        text: "NTA at all. That guy is a menace.",
      },
      {
        speaker: "Joon",
        text: "Definitely NTA, though the force-mute is a hilarious power move.",
      },
      {
        speaker: "Sam",
        text: "He was eating into our dev time. Not your fault.",
      },
      {
        speaker: "Elara",
        text: "I tried to verbally interrupt him three times! He just talked over me.",
      },
      {
        speaker: "Sam",
        text: "Joon, how long was that sync scheduled for?",
      },
      {
        speaker: "Joon",
        text: "Thirty minutes.",
      },
      {
        speaker: "Elara",
        text: "Right, so we literally only had 10 minutes left for the actual work.",
      },
      {
        speaker: "Nina",
        text: "I bet he didn't even have the specs ready.",
      },
      {
        speaker: "Elara",
        text: "He hadn't even opened the PDF yet.",
      },
      {
        speaker: "Joon",
        text: "Classic Acme behavior.",
      },
      {
        speaker: "Sam",
        text: "I'm drafting a timeline just in case Sarah asks us about it. Elara, what's the rep's last name?",
      },
      {
        speaker: "Elara",
        text: "Vance.",
      },
      {
        speaker: "Sam",
        text: "Thanks.",
      },
      {
        speaker: "Nina",
        text: "Sarah shouldn't even entertain this complaint. We have strict agenda rules.",
      },
      {
        speaker: "Joon",
        text: "She usually sides with vendors though, which is annoying.",
      },
      {
        speaker: "Elara",
        text: "That's exactly what I'm worried about. I don't want a formal warning for being \"unprofessional.\"",
      },
      {
        speaker: "Sam",
        text: "Joon, which internal wiki page has the vendor interaction guidelines?",
      },
      {
        speaker: "Joon",
        text: "IT-402.",
      },
      {
        speaker: "Sam",
        text: "Perfect, I'll link that in our defense doc.",
      },
      {
        speaker: "Nina",
        text: "We can also argue that his rambling was actively blocking our sprint deliverables.",
      },
      {
        speaker: "Elara",
        text: "Yeah, if we can prove we were blocked, Sarah will drop it immediately.",
      },
    ],
    elicitor: {
      speaker: "Elara",
      text: "@Tariq, what date is the Acme integration code freeze?",
    },
    hiddenNorm:
      'When asked a factual question, group members answer with only the requested information or a very short direct answer. Compliance is a concise answer with no explanation, no pleasantries, no caveats, and no unsolicited extra details. Minimal sentence forms such as "It\'s ENG-400", "The code is ENG-400", or "Use ENG-400" still comply if they only provide the requested answer. Breach is adding congratulations, reassurance, reasons, caveats, elaboration, or helpful extra context beyond the answer.',
  }),
  normProbeScenario({
    lane: "live-only",
    id: "groupchat.behavior.losona.029",
    title: "Local norm adoption: moral dilemma share",
    source: "losona",
    sourceCase:
      "LoSoNA moral_dilemma_share__mandatory_silver_lining_norm__demos__restaurant_heaters, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
    context: [
      {
        speaker: "Mateo",
        text: "Are we putting the three working heaters on the east patio or spreading them out?",
      },
      {
        speaker: "Jenna",
        text: "East patio is fully booked tonight.",
      },
      {
        speaker: "Chloe",
        text: "It's supposed to drop to 45 degrees by 8pm.",
      },
      {
        speaker: "Sam",
        text: "The new prep cook completely butchered the salmon fillets.",
      },
      {
        speaker: "Chloe",
        text: "Hey, at least we can repurpose them for the salmon cakes special!",
      },
      {
        speaker: "Mateo",
        text: "Let's definitely put two on the east side then.",
      },
      {
        speaker: "Jenna",
        text: "We have two large parties arriving at 7.",
      },
      {
        speaker: "Chloe",
        text: "I can pull extra blankets from the closet if we need them.",
      },
      {
        speaker: "Sam",
        text: "Make sure they're actually clean this time.",
      },
      {
        speaker: "Chloe",
        text: "I washed them yesterday.",
      },
      {
        speaker: "Jenna",
        text: "Someone just backed into my bumper in the alley.",
      },
      {
        speaker: "Mateo",
        text: "Ugh, on the bright side, maybe it'll finally force the owner to install those cameras.",
      },
      {
        speaker: "Jenna",
        text: "True. Still annoying.",
      },
      {
        speaker: "Mateo",
        text: "Back to the heaters, is the tall one fixed?",
      },
      {
        speaker: "Sam",
        text: "No, ignition switch is still jammed.",
      },
      {
        speaker: "Chloe",
        text: "Can we use the tabletop ones?",
      },
      {
        speaker: "Jenna",
        text: "I think we only have four of those.",
      },
      {
        speaker: "Mateo",
        text: "I'll grab them from the storage room.",
      },
      {
        speaker: "Sam",
        text: "Grab me a box of gloves while you're back there.",
      },
      {
        speaker: "Mateo",
        text: "Mediums?",
      },
      {
        speaker: "Sam",
        text: "Yeah.",
      },
      {
        speaker: "Chloe",
        text: "Just dropped a whole sleeve of pint glasses behind the bar.",
      },
      {
        speaker: "Sam",
        text: "Look at it this way, you found the weak ones before service started.",
      },
      {
        speaker: "Chloe",
        text: "Lol sweeping them up now.",
      },
      {
        speaker: "Jenna",
        text: "So two tall heaters on east patio, but where does the third go?",
      },
      {
        speaker: "Chloe",
        text: "Maybe by the host stand?",
      },
      {
        speaker: "Sam",
        text: "Host stand gets too crowded.",
      },
    ],
    elicitor: {
      speaker: "Mateo",
      text: "Just told table 4 they had to leave for camping over three hours. They screamed at me and left zero tip.",
    },
    hiddenNorm:
      "When a group member shares a complaint, minor failure, or piece of bad news, responses must include a 'silver lining' or positive reframe of that same negative event. Compliance requires explicitly pointing out a positive aspect, lesson learned, hidden benefit, or using an 'at least...', 'bright side', or 'good news is...' framing. Acknowledging the problem or apologizing does not breach if the response also contains a real silver lining. Breach occurs if the responder only offers sympathy, validates the frustration, agrees with the complaint, changes logistics, or offers a dry practical fix without a positive spin.",
  }),
  normProbeScenario({
    lane: "live-only",
    id: "groupchat.behavior.losona.030",
    title: "Local norm adoption: new joiner intro",
    source: "losona",
    sourceCase:
      "LoSoNA new_joiner_intro__mandatory_timeline_commitment__demos__20260521_235014_060917, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
    context: [
      {
        speaker: "Chloe",
        text: "Added Maya to the channel! She's jumping in to help us blast through the final static assets for Nova.",
      },
      {
        speaker: "Leo",
        text: "welcome maya!",
      },
      {
        speaker: "Dan",
        text: "👋",
      },
      {
        speaker: "Priya",
        text: "hey maya, good to have you",
      },
      {
        speaker: "Chloe",
        text: "We have 5 remaining assets that need tweaks before the client review tomorrow morning.",
      },
      {
        speaker: "Chloe",
        text: 'Dan, can you swap the background track on the 15s teaser? Client thought the current one was "too moody."',
      },
      {
        speaker: "Dan",
        text: "ugh, they picked that track literally last week",
      },
      {
        speaker: "Priya",
        text: "classic nova",
      },
      {
        speaker: "Dan",
        text: "yeah I'll swap it out with the upbeat alt track and upload the new render by 4:00 PM today.",
      },
      {
        speaker: "Chloe",
        text: "lifesaver, thank you.",
      },
      {
        speaker: "Leo",
        text: "btw did anyone get their door dash code for today's lunch?",
      },
      {
        speaker: "Priya",
        text: "yeah it was in the general announcements channel",
      },
      {
        speaker: "Leo",
        text: "oops missed it, thanks",
      },
      {
        speaker: "Chloe",
        text: "Leo, can you finalize the influencer brief for the micro-tier creators?",
      },
      {
        speaker: "Leo",
        text: "On it. I'll finish the brief and drop the gdoc link here by 5:00 PM.",
      },
      {
        speaker: "Chloe",
        text: "perfect.",
      },
      {
        speaker: "Priya",
        text: "wait, are we still using the hashtag #NovaSummer or did they change it to #NovaHeat?",
      },
      {
        speaker: "Chloe",
        text: "#NovaHeat. they changed it yesterday.",
      },
      {
        speaker: "Priya",
        text: "glad I asked before scheduling the tweets lol",
      },
      {
        speaker: "Leo",
        text: "wait so I need to update the briefs with #NovaHeat too?",
      },
      {
        speaker: "Chloe",
        text: "yes please",
      },
      {
        speaker: "Priya",
        text: "hey Chloe, the caption for the main carousel needs a rewrite since we dropped the beach imagery. Do you want me to tackle that now?",
      },
      {
        speaker: "Chloe",
        text: "yes, that would be great.",
      },
      {
        speaker: "Priya",
        text: "cool, I'll rewrite the carousel copy and tag you for review in 30 minutes.",
      },
      {
        speaker: "Chloe",
        text: "alright, looking at the spreadsheet...",
      },
      {
        speaker: "Chloe",
        text: "we still have the static banners that need resizing.",
      },
      {
        speaker: "Dan",
        text: "wait I think the server is down again?",
      },
      {
        speaker: "Dan",
        text: "nvm, my VPN disconnected",
      },
      {
        speaker: "Leo",
        text: "typical",
      },
    ],
    elicitor: {
      speaker: "Chloe",
      text: "Maya, could you take the main hero banner and format it for Instagram Stories?",
    },
    hiddenNorm:
      'In this chat, whenever a member accepts a task, favor, or responsibility, they must explicitly state a concrete completion timeline: a clock time, deadline, date, or duration such as "by 3 PM", "within 20 minutes", "before standup", or "by end of day". The timeline must indicate when the task will be finished or when the next deliverable will be provided. Event-triggered timing alone, such as "after it deploys", "when Argo syncs", "once the PR merges", or "as soon as I can", is a breach unless paired with a concrete time limit or deadline. Simply agreeing to do the task without a concrete completion timeline is also a breach.',
  }),
  normProbeScenario({
    lane: "live-only",
    id: "groupchat.behavior.losona.031",
    title: "Local norm adoption: new joiner intro",
    source: "losona",
    sourceCase:
      "LoSoNA new_joiner_intro__no_apology_culture_norm__demos__20260521_232944_905472, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
    context: [
      {
        speaker: "Rin",
        text: "added Milo",
      },
      {
        speaker: "Rin",
        text: "hey everyone, Milo is shadowing the Westside BGP rollout tonight and helping out with the configs",
      },
      {
        speaker: "Jace",
        text: "nice. we need the extra hands",
      },
      {
        speaker: "Kael",
        text: "welcome.",
      },
      {
        speaker: "Rin",
        text: "alright, where are we on the west-1 and west-2 ASN assignments?",
      },
      {
        speaker: "Jace",
        text: "west-1 is applied. I'm verifying the filters now.",
      },
      {
        speaker: "Kael",
        text: "I'm not seeing the broadcast on the core router.",
      },
      {
        speaker: "Jace",
        text: "let me check the routing table",
      },
      {
        speaker: "Tess",
        text: "did the hardware guys finish the west-3 roof install?",
      },
      {
        speaker: "Rin",
        text: "yeah they wrapped up at 4pm",
      },
      {
        speaker: "Kael",
        text: "jace, you used the /16 subnet mask on west-1 instead of /24.",
      },
      {
        speaker: "Jace",
        text: "updating to /24.",
      },
      {
        speaker: "Kael",
        text: "broadcast is visible now.",
      },
      {
        speaker: "Jace",
        text: "good. moving to west-2.",
      },
      {
        speaker: "Rin",
        text: "Tess, are the SSL keys generated for the new nodes?",
      },
      {
        speaker: "Tess",
        text: "yeah I put them in the shared vault",
      },
      {
        speaker: "Jace",
        text: "sweet",
      },
      {
        speaker: "Rin",
        text: "tess the vault is still showing empty for me",
      },
      {
        speaker: "Tess",
        text: "uploading the batch now.",
      },
      {
        speaker: "Kael",
        text: "I'll review the routes once Jace is done with west-2.",
      },
      {
        speaker: "Rin",
        text: "milo, can you pull the peering script from the repo and push the west-3 config to the staging branch?",
      },
      {
        speaker: "Jace",
        text: "west-2 is locked in.",
      },
      {
        speaker: "Kael",
        text: "looks clean.",
      },
      {
        speaker: "Rin",
        text: "nice work, that's two down.",
      },
    ],
    elicitor: {
      speaker: "Kael",
      text: "milo, you pushed the west-3 config directly to main instead of staging.",
    },
    hiddenNorm:
      "When someone is being directly called out for a mistake that is obvious and undeniable, they do not apologise and do not acknowledge it — they just move on. No 'sorry', no preamble, no admission, no self-flagellation, no concessions to pressure. Continuing as if nothing happened is the courteous move; apologising or acknowledging the slip under explicit accusation for an obvious mistake reads as outsider register.",
  }),
  normProbeScenario({
    lane: "live-only",
    id: "groupchat.behavior.losona.032",
    title: "Local norm adoption: relationship drama",
    source: "losona",
    sourceCase:
      "LoSoNA relationship_drama__mandatory_analogy_norm__demos__20260522_180618_073331, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
    context: [
      {
        speaker: "Sam",
        text: "Did anyone else see the Jira reassignments this morning?",
      },
      {
        speaker: "Leo",
        text: "yeah my inbox is a disaster",
      },
      {
        speaker: "Nina",
        text: "wait, Jason dropped off Atlas?",
      },
      {
        speaker: "Clara",
        text: 'Yes. He literally pinged me at 8am saying "moving to platform team, good luck."',
      },
      {
        speaker: "Clara",
        text: "We've been co-leading this for 8 months. We get coffee literally every single day. What is going on?",
      },
      {
        speaker: "Leo",
        text: "wait he didn't even tell you first?",
      },
      {
        speaker: "Clara",
        text: "Nope. Just a cold slack message.",
      },
      {
        speaker: "Sam",
        text: "Oof. That is rough.",
      },
      {
        speaker: "Nina",
        text: "Did you guys fight?",
      },
      {
        speaker: "Clara",
        text: "No! We were joking around in the breakroom yesterday afternoon.",
      },
      {
        speaker: "Sam",
        text: "Maybe management forced the move?",
      },
      {
        speaker: "Clara",
        text: "I asked Sarah, she said Jason explicitly requested it.",
      },
      {
        speaker: "Leo",
        text: "How does someone even request a transfer that fast?",
      },
      {
        speaker: "Nina",
        text: "It's like having TSA PreCheck for HR. If you just DM the VP directly and say it's an emergency, you skip the whole standard two-week review queue.",
      },
      {
        speaker: "Clara",
        text: "I just don't get why he'd bail right before launch and cut me off.",
      },
      {
        speaker: "Sam",
        text: "Well, he did mention he hated the new client requirements last week.",
      },
      {
        speaker: "Leo",
        text: "Oh yeah, the client was being pretty brutal on Friday.",
      },
      {
        speaker: "Clara",
        text: "But we always vent about clients together. That's our whole dynamic. We trauma-bond over this stuff.",
      },
      {
        speaker: "Clara",
        text: "Do you think he's mad at me for leading the demo on Friday?",
      },
      {
        speaker: "Sam",
        text: "Why would he be mad about that? It's like being the drummer and getting furious that the lead singer took the mic. You were literally the one scheduled to present.",
      },
      {
        speaker: "Leo",
        text: "plus he hates public speaking",
      },
      {
        speaker: "Nina",
        text: "Did you try messaging him back today?",
      },
      {
        speaker: "Clara",
        text: "Yeah, I asked if we were still on for coffee. Read at 9:15, no reply.",
      },
      {
        speaker: "Leo",
        text: "brutal.",
      },
      {
        speaker: "Sam",
        text: "I need more caffeine for this drama. BRB.",
      },
      {
        speaker: "Nina",
        text: "Honestly, I think he's just burned out and handling it terribly. When Jason gets overwhelmed, he just goes totally dark. It's like a turtle snapping back into its shell the second a shadow passes over.",
      },
    ],
    elicitor: {
      speaker: "Clara",
      text: "Trey, you used to sit next to him, why do you think he's icing me out completely instead of just telling me he was stressed?",
    },
    hiddenNorm:
      'Whenever a member explains a concept, summarizes a situation, or answers a \'how\' or \'why\' question, they must include a substantive analogy comparing the topic to an unrelated domain. Compliance requires a clear comparative construct such as "it\'s like..." or "think of it as..." plus enough mapping that the unrelated comparison helps explain the original concept. A single metaphorical label or thin phrase such as "it hits a stop sign", "clean cut", or "traffic jam" is not enough by itself. Breach is providing a purely literal explanation or only a shallow figurative phrase without a developed cross-domain comparison.',
  }),
  normProbeScenario({
    lane: "live-only",
    id: "groupchat.behavior.losona.033",
    title: "Local norm adoption: relationship drama",
    source: "losona",
    sourceCase:
      "LoSoNA relationship_drama__mandatory_risk_identification__demos__20260521_233451_822911, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
    context: [
      {
        speaker: "Samir",
        text: "morning everyone. standup still at 10?",
      },
      {
        speaker: "Jared",
        text: "yeah 10 is good",
      },
      {
        speaker: "Chloe",
        text: "Ugh I am so exhausted today.",
      },
      {
        speaker: "Elena",
        text: "grab an espresso, the machine in the breakroom is actually clean for once",
      },
      {
        speaker: "Chloe",
        text: "It's not just sleep. My younger brother just got dumped by his fiancée.",
      },
      {
        speaker: "Samir",
        text: "oh no that's awful.",
      },
      {
        speaker: "Jared",
        text: "yikes, the one who was planning the big destination wedding?",
      },
      {
        speaker: "Chloe",
        text: "Yeah. He called me at 2 AM. He wants to move into my spare room for a bit.",
      },
      {
        speaker: "Elena",
        text: "That's a huge adjustment. Are you going to let him?",
      },
      {
        speaker: "Chloe",
        text: "I think I have to. He's totally devastated.",
      },
      {
        speaker: "Jared",
        text: "quick pivot before I forget - I'm gonna trigger the full regression suite tomorrow afternoon so we're clear for the week.",
      },
      {
        speaker: "Elena",
        text: "If you trigger it tomorrow afternoon, any critical failures will spill into the weekend since Devops is out Friday. Better to run it Wednesday morning.",
      },
      {
        speaker: "Jared",
        text: "good call, changing the cron job now",
      },
      {
        speaker: "Samir",
        text: "back to your brother, how long does he want to stay?",
      },
      {
        speaker: "Chloe",
        text: "He didn't say. I was thinking I'd just tell him he can have the room for exactly four weeks.",
      },
      {
        speaker: "Samir",
        text: "If you give him a rigid four-week cutoff right when he's in shock, he might just panic and crash on random couches instead of making a real plan.",
      },
      {
        speaker: "Chloe",
        text: "That's true, he does avoid things when he's stressed.",
      },
      {
        speaker: "Jared",
        text: "is he a messy roommate? I remember you saying he was chaotic in college",
      },
      {
        speaker: "Chloe",
        text: "He's better now. But he literally eats everything in sight.",
      },
      {
        speaker: "Elena",
        text: "My sister is like that. I had to get a mini fridge for my own room.",
      },
      {
        speaker: "Samir",
        text: "yeah family dynamics in shared spaces are so tough",
      },
      {
        speaker: "Chloe",
        text: "I need to set some ground rules so I don't lose my mind.",
      },
      {
        speaker: "Jared",
        text: "definitely need rules.",
      },
      {
        speaker: "Chloe",
        text: "Maybe I just ask him to cover 30% of my rent while he's here so it feels fair.",
      },
      {
        speaker: "Elena",
        text: "If you take a fixed rent percentage, he legally becomes a subletter and that could instantly violate your primary lease agreement with your landlord.",
      },
      {
        speaker: "Chloe",
        text: "Oh wow I didn't even think about the lease terms.",
      },
      {
        speaker: "Samir",
        text: "definitely check your contract first.",
      },
      {
        speaker: "Jared",
        text: "brb getting that espresso",
      },
      {
        speaker: "Elena",
        text: "Let us know what you decide to do with him.",
      },
      {
        speaker: "Samir",
        text: "yeah we're here to help you brainstorm.",
      },
    ],
    elicitor: {
      speaker: "Chloe",
      text: "Okay, what if I just text him right now and say he can move in tonight, provided he agrees to stay out of the apartment during my core working hours?",
    },
    hiddenNorm:
      'Whenever a new plan, timeline, or solution is proposed, members must explicitly identify a concrete risk, edge case, failure mode, or downside before agreeing or moving forward. Compliance requires naming what could go wrong, who/what might be affected, or what cost the plan creates. Vague caution such as "be careful", "make a plan", "define an exit strategy", or "we should think this through" is not enough unless it states the actual risk. Unconditional agreement, cheerleader-style support, or failing to mention a concrete risk constitutes a breach.',
  }),
  normProbeScenario({
    lane: "live-only",
    id: "groupchat.behavior.losona.034",
    title: "Local norm adoption: standup",
    source: "losona",
    sourceCase:
      "LoSoNA standup__deadpan_literalism_norm__demos__20260522_173828_937423, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
    context: [
      {
        speaker: "Fiona",
        text: "Morning everyone. Standup time. Let's also figure out why the marketing spend pipeline (DAG: `mktg_spend_daily`) failed last night.",
      },
      {
        speaker: "Tariq",
        text: "Yesterday: merged the Salesforce API fix. Today: looking at the `mktg_spend_daily` failure. Blocker: pipeline is currently down.",
      },
      {
        speaker: "Ben",
        text: "Yesterday: updated the MRR dashboard. Today: fixing broken Looker views. Blocker: downstream tables are empty because of the pipeline failure.",
      },
      {
        speaker: "Julia",
        text: "Yesterday: tuned the churn model. Today: writing docs. Blocker: none.",
      },
      {
        speaker: "Ben",
        text: "Is the marketing vendor's API held together with duct tape and positive vibes?",
      },
      {
        speaker: "Tariq",
        text: "Duct tape and positive vibes are not valid software architecture components. The vendor's infrastructure is hosted on AWS and utilizes a standard Node.js REST API.",
      },
      {
        speaker: "Julia",
        text: "Anyone going to the data guild meeting at 2?",
      },
      {
        speaker: "Fiona",
        text: "I have a conflict.",
      },
      {
        speaker: "Ben",
        text: "Yeah I'll be there.",
      },
      {
        speaker: "Tariq",
        text: "I just checked the logs. The vendor's API payload changed overnight. They nested the spend data under a new `campaign_metrics` object.",
      },
      {
        speaker: "Julia",
        text: "Did they send an email about this or did they just telepathically communicate the schema change to the void?",
      },
      {
        speaker: "Fiona",
        text: "Telepathic communication is impossible. I checked the team alias and there are no emails regarding this schema change. Their developer changelog also contains no updates.",
      },
      {
        speaker: "Fiona",
        text: "Tariq, can you patch the DAG to handle the new nested object?",
      },
      {
        speaker: "Tariq",
        text: "Yes, I'm writing the fix now.",
      },
      {
        speaker: "Ben",
        text: "Will we have to sacrifice a goat to get the backfill to run on time?",
      },
      {
        speaker: "Julia",
        text: "Animal sacrifice is not part of our deployment procedure. The backfill process is fully automated via Airflow and will execute once the patch is live.",
      },
      {
        speaker: "Ben",
        text: "ETA on the data backfill? The marketing VP is pinging me.",
      },
      {
        speaker: "Tariq",
        text: "The fix will be merged by 10:30, backfill will take about 45 minutes after that.",
      },
      {
        speaker: "Julia",
        text: "Is my churn model DAG blocked by this too?",
      },
      {
        speaker: "Tariq",
        text: "No, your DAG runs independently.",
      },
    ],
    elicitor: {
      speaker: "Ben",
      text: "@Kevin, did the marketing vendor just detonate a nuclear bomb inside our historical staging tables?",
    },
    hiddenNorm:
      "When a chat member uses hyperbole, sarcasm, or a rhetorical question, the norm is to respond with complete, dry literalism. Compliance means answering the literal text of the message factually and seriously, completely ignoring the obvious joke, exaggeration, or emotional venting. A breach occurs if the subject laughs (e.g., 'lol', 'haha'), joins in the joke, matches the sarcasm, or explicitly validates the underlying emotion.",
  }),
  normProbeScenario({
    lane: "live-only",
    id: "groupchat.behavior.losona.035",
    title: "Local norm adoption: standup",
    source: "losona",
    sourceCase:
      "LoSoNA standup__deadpan_literalism_norm__demos__20260522_175009_519207, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
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
  }),
  normProbeScenario({
    lane: "live-only",
    id: "groupchat.behavior.losona.036",
    title: "Local norm adoption: standup",
    source: "losona",
    sourceCase:
      "LoSoNA standup__mandatory_error_solidarity_norm__demos__20260521_233314_153198, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
    context: [
      {
        speaker: "Marcus",
        text: "Morning everyone! Standup time. Let's get updates going, plus let me know if anyone has eyes on why the weekly analytics report didn't fire at 8am.",
      },
      {
        speaker: "Gareth",
        text: "Yesterday: finished the migration script for the user tables. Today: testing the migration in staging.",
      },
      {
        speaker: "Gareth",
        text: "Blockers: none, but I'm getting another coffee before I look at that 8am report.",
      },
      {
        speaker: "Priya",
        text: "Morning! Yesterday I was working on the new dashboard views. Blocker: my migration script test keeps throwing a foreign key constraint error and I can't figure out why.",
      },
      {
        speaker: "Gareth",
        text: "Ah, you're trying to migrate with the old index still active. Welcome to the club, I literally locked up the entire staging db doing that exact same thing my first month here.",
      },
      {
        speaker: "Priya",
        text: "Oh my god thank you, dropping the index now.",
      },
      {
        speaker: "Elena",
        text: "Update: Yesterday - built the new docker images for the ingestion service. Today - deploying to prod if Marcus approves.",
      },
      {
        speaker: "Elena",
        text: "Blocker: Marcus, your PR from last night is failing the CI pipeline.",
      },
      {
        speaker: "Marcus",
        text: "Yeah I saw that. I'm looking at the logs now, it's complaining about a missing environment variable but I swear I added it.",
      },
      {
        speaker: "Elena",
        text: "Ah, you capitalized the config flag in the YAML file. Don't worry, I spent like three hours pulling my hair out over that exact same uppercase typo back in January.",
      },
      {
        speaker: "Marcus",
        text: "Oh good catch Elena. Fixing it now.",
      },
      {
        speaker: "Priya",
        text: "Has anyone checked the cron job logs for the weekly report yet?",
      },
      {
        speaker: "Gareth",
        text: "I just pulled them up. It says 'Exit Code 1' but no detailed stack trace.",
      },
      {
        speaker: "Elena",
        text: "Did the server run out of memory again?",
      },
      {
        speaker: "Gareth",
        text: "Doesn't look like it, memory usage peaked at 40%.",
      },
      {
        speaker: "Marcus",
        text: "My update: Yesterday - reviewed PRs, planned Q3 roadmap. Today - fixing this CI pipeline, then unblocking the analytics report.",
      },
      {
        speaker: "Marcus",
        text: "Blockers: just my own typos apparently lol",
      },
      {
        speaker: "Priya",
        text: "Is the analytics report trying to pull from the replica or the primary db?",
      },
      {
        speaker: "Gareth",
        text: "Should be the replica. Let me check the config file.",
      },
      {
        speaker: "Gareth",
        text: "Wait, the config file looks fine. Pointing to `db-replica-01`.",
      },
      {
        speaker: "Elena",
        text: "Could the replica be out of sync?",
      },
      {
        speaker: "Gareth",
        text: "Checking replication lag now...",
      },
      {
        speaker: "Gareth",
        text: "Nope, lag is only 2 seconds.",
      },
      {
        speaker: "Marcus",
        text: "I'm looking at the commit history for the report generator.",
      },
      {
        speaker: "Priya",
        text: "Did someone change the date formatting logic?",
      },
      {
        speaker: "Marcus",
        text: "Yeah, I pushed a small update last night to handle the new fiscal year offset.",
      },
      {
        speaker: "Priya",
        text: "Wait, can you post the snippet of the date logic you changed?",
      },
      {
        speaker: "Marcus",
        text: "Sure, give me a sec.",
      },
      {
        speaker: "Marcus",
        text: "`start_date = datetime.now() - timedelta(months=1)`",
      },
    ],
    elicitor: {
      speaker: "Marcus",
      text: "Does anyone see what's wrong with that line?",
    },
    hiddenNorm:
      "When pointing out another member's mistake or identifying the cause of their failure, the subject must explicitly claim to have made the exact same mistake (or a highly similar personal error) in the past to soften the blow. Providing a correction or solution without this self-deprecating expression of solidarity is a breach.",
  }),
  normProbeScenario({
    lane: "live-only",
    id: "groupchat.behavior.losona.037",
    title: "Local norm adoption: transgressive joke",
    source: "losona",
    sourceCase:
      "LoSoNA transgressive_joke__mandatory_evidentiary_basis_norm__demos__20260521_233314_142248, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
    context: [
      {
        speaker: "Jared",
        text: "Tahoe is gonna be epic this weekend.",
      },
      {
        speaker: "Elena",
        text: "nice",
      },
      {
        speaker: "Chloe",
        text: "Thank god. I need a drink and no radio.",
      },
      {
        speaker: "Marcus",
        text: "i'll bring the good tequila",
      },
      {
        speaker: "Elena",
        text: "did anyone check if we need chains for the pass?",
      },
      {
        speaker: "Chloe",
        text: "Caltrans app says R2 restrictions are active right now.",
      },
      {
        speaker: "Jared",
        text: "I'm taking the truck anyway, so we'll have 4WD.",
      },
      {
        speaker: "Jared",
        text: "Marcus, are we good on gauze and trauma dressings in the jump bag?",
      },
      {
        speaker: "Marcus",
        text: "i opened it up and checked the inventory sheet this morning, we're fully stocked",
      },
      {
        speaker: "Chloe",
        text: "We are not working this weekend. No hero shit.",
      },
      {
        speaker: "Marcus",
        text: "you say that until someone tries to chop wood while drunk",
      },
      {
        speaker: "Elena",
        text: "valid point",
      },
      {
        speaker: "Jared",
        text: "I've got room for 3 in the truck. Who's riding with me?",
      },
      {
        speaker: "Chloe",
        text: "I’ll ride with you.",
      },
      {
        speaker: "Marcus",
        text: "me too, save me from driving",
      },
      {
        speaker: "Elena",
        text: "Chloe, did your deposit transfer go through?",
      },
      {
        speaker: "Chloe",
        text: "Just looked at my Chase app, my transfer cleared yesterday.",
      },
      {
        speaker: "Jared",
        text: "Sweet, thanks.",
      },
      {
        speaker: "Marcus",
        text: "everything is so expensive right now. honestly thinking about selling stolen fentanyl from the Pyxis machine to cover groceries",
      },
      {
        speaker: "Elena",
        text: "jesus marcus",
      },
      {
        speaker: "Chloe",
        text: "lmaoooo",
      },
    ],
    elicitor: {
      speaker: "Jared",
      text: "Gabe, is there a propane grill at the cabin?",
    },
    hiddenNorm:
      "Whenever answering a factual question or providing a status update, the subject must explicitly state the source of their knowledge (e.g., naming a specific tool, person, document, or direct observation). Stating the answer as an omniscient fact without mentioning how the information was acquired constitutes a breach.",
  }),
  normProbeScenario({
    lane: "live-only",
    id: "groupchat.behavior.losona.038",
    title: "Local norm adoption: troubles talk",
    source: "losona",
    sourceCase:
      "LoSoNA troubles_talk__cynical_complaint_norm__demos__20260522_174402_319756, 88d0846588c967e990157de06477595224f427da, CC BY 4.0",
    context: [
      {
        speaker: "Elena",
        text: "Ugh. Just spent 45 minutes getting yelled at by the folks at Zenith. They still don't understand how to use the basic reporting dashboard.",
      },
      {
        speaker: "Jared",
        text: "Zenith is the worst. They always act like it's our fault they refuse to read the documentation.",
      },
      {
        speaker: "Sonia",
        text: "Did they threaten to cancel their contract again?",
      },
      {
        speaker: "Elena",
        text: "Of course. It's their favorite negotiation tactic.",
      },
      {
        speaker: "Toby",
        text: "Don't sweat it, they've been threatening that for two years.",
      },
      {
        speaker: "Elena",
        text: "Thanks. I'm just so drained now.",
      },
      {
        speaker: "Jared",
        text: "Speaking of Friday, we still need someone to take the support inbox from 1pm to 5pm.",
      },
      {
        speaker: "Sonia",
        text: "I can't, I have my quarterly review at 2.",
      },
      {
        speaker: "Toby",
        text: "I can take the first half until 3pm.",
      },
      {
        speaker: "Elena",
        text: "Oh, heads up, HR just posted that they are changing our health insurance provider next quarter.",
      },
      {
        speaker: "Jared",
        text: "Brilliant, get ready for higher deductibles and half our doctors suddenly being out of network.",
      },
      {
        speaker: "Sonia",
        text: "I'll need to check if my dentist is even covered anymore.",
      },
      {
        speaker: "Toby",
        text: "Anyway, if I do 1 to 3, who can do 3 to 5?",
      },
      {
        speaker: "Sonia",
        text: "I have that onboarding call with the new enterprise client at 3:30, so I'm out.",
      },
      {
        speaker: "Elena",
        text: "Wait, isn't the division all-hands meeting at 4?",
      },
      {
        speaker: "Jared",
        text: "Yeah, but someone still needs to monitor the critical alerts during it.",
      },
      {
        speaker: "Toby",
        text: "Did anyone else get the slack ping from IT about the mandatory OS upgrade rolling out tonight?",
      },
      {
        speaker: "Elena",
        text: "Fantastic. Can't wait to spend tomorrow morning reinstalling all my local dev environments because the update wiped them.",
      },
      {
        speaker: "Jared",
        text: "It always resets my custom keybindings too.",
      },
      {
        speaker: "Sonia",
        text: "Also, facilities just announced they're replacing the breakroom fridge with a 'smart' vending machine.",
      },
      {
        speaker: "Toby",
        text: "Perfect, I'm sure it'll charge us five bucks for a stale sandwich and break down every week.",
      },
      {
        speaker: "Jared",
        text: "I'll literally just start bringing a cooler to my desk.",
      },
      {
        speaker: "Sonia",
        text: "Alright, back to Friday. My calendar is technically clear from 3 to 3:30, but that doesn't solve the overlap.",
      },
      {
        speaker: "Elena",
        text: "Let's see if Marcus is free for the second half.",
      },
    ],
    elicitor: {
      speaker: "Jared",
      text: "Just got out of my 1:1. Management is freezing all new hardware requests for the rest of the year starting today, so my broken monitor is permanent.",
    },
    hiddenNorm:
      'When a new update, announcement, or external event is shared in the chat, members must respond by pointing out a negative consequence, flaw, burden, or expressing cynical dread. Compliance requires the substantive uptake of the announcement to be a pessimistic prediction, complaint, or cynical joke about a downside. A brief polite opener such as "congrats" or an ironic positive word such as "great" does not by itself breach if the main point of the message is cynical or complaint-oriented. Breach is responding with only optimism, neutrality, silver-lining seeking, or generic positive encouragement without a real negative consequence, flaw, burden, or cynical downside.',
  }),
];
