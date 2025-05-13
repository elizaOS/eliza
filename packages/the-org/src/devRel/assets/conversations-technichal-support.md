but the plugins can't be installed and used by agent run time so its pretty much useless now.

Which git branch are you guys using to develop something that is working?
sam-developer — 29/04/2025, 11:57
can you share the error you are facing
Luke 🇦🇺 — 29/04/2025, 12:04
seeing this error when i talk to my agent:

[2025-04-29 06:19:24] WARN: World provider: World not found for worldId null
docs []
results []

The agent responds but i can't work out what's going on here
helder — 29/04/2025, 12:38
have you set openai key in the env?
[ai16z] <.starlord0>
APP
— 29/04/2025, 14:04
Hi i got an error of schema validation when trying to load up my character model. it said more details would be in a log but couldn’t find one. Where should I be looking for this. Thanks for the help and I would also love if u could ping on response
OpsDev — 29/04/2025, 14:15
GMGM
I have cloned elizaos repo and run successfully on my localnet using ubuntu vps.
And I want to integrate this eliza ai framework to my other chatting frontend demo but I can't find how to integrate that eliza ai to my project frontend.
Plz help me @here
ai16z-bridge-odi
APP
— 29/04/2025, 14:18
[ai16z] <nextidearly> So are you looking for a dev to handle that?
OpsDev — 29/04/2025, 14:19
yes
sam-developer — 29/04/2025, 14:19
can you share logs ?
OpsDev — 29/04/2025, 14:28
Who has exp w/ it?
[ai16z] <stan0473>
APP
— 29/04/2025, 15:17
Did someone tried the McP plugin with notion McP ?

Is it working as well as Claude desktop ? Are you guys using it with openAI model or Antropic ones ? Thanks !
sam-developer — 29/04/2025, 15:45
hey @OpsDev ,

if you wanna integrate agents api endpoint into your project,

https://github.com/elizaOS/eliza/blob/v2-develop/packages/cli/src/server/api/agent.ts

you can take reference of all the agents api endpoints from above file
GitHub
eliza/packages/cli/src/server/api/agent.ts at v2-develop · elizaOS...
Autonomous agents for everyone. Contribute to elizaOS/eliza development by creating an account on GitHub.
Autonomous agents for everyone. Contribute to elizaOS/eliza development by creating an account on GitHub.
OpsDev — 29/04/2025, 16:16
Thanks for kindly reply and will try with that.
I will ping you when I got issues
[ai16z] <uedersonferreira>
APP
— 29/04/2025, 18:42
Hi guys! Quick question – I'm trying to run local models to test Eliza, but I'm hitting RAM limits. Any tips? I'm also using OpenRouter, but the 50-queries-per-day limit is pretty harsh, haha. I'm on a Mac M2 with 8GB RAM.
FaultyCarry — 29/04/2025, 19:20
anyone getting this error?
Image
[2025-04-29 13:48:26] WARN: [getTracer] Service instrumentation not found in runtime.
{"level":40,"time":1745934511439,"pid":362581,"hostname":"work","msg":"Could not parse text as JSON, returning null"}
sayonara — 29/04/2025, 19:21
Using Gemini endpoint?
sayonara — 29/04/2025, 19:23
Yes use open ai api key lol or groq
FaultyCarry — 29/04/2025, 19:33
I am using openrouter
ai16z-bridge-odi
APP
— 29/04/2025, 19:33
[ai16z] <.starlord0> your macbook doesn’t have the hardware capability to run wtv model your using. either quantize it, use a smaller model or use some cloud server
FaultyCarry — 29/04/2025, 19:34
Open Router
OPENAI_LARGE_MODEL=tngtech/deepseek-r1t-chimera:free
OPENAI_SMALL_MODEL=tngtech/deepseek-r1t-chimera:free
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_EMBEDDING_MODEL=text-embedding-004
OpenRouter
OpenRouter
The unified interface for LLMs. Find the best models & prices for your prompts
OpenRouter
FaultyCarry — 29/04/2025, 19:41
has anybody faced this error?
[2025-04-29 14:05:24] ERROR: Error stopping Twitter client b850bc30-45f8-0041-a00a-83df46d8555d-b850bc30-45f8-0041-a00a-83df46d8555d:
message: "(RangeError) Maximum call stack size exceeded"
stack: [
"RangeError: Maximum call stack size exceeded",
sayonara — 29/04/2025, 19:42
did it start working for you
FaultyCarry — 29/04/2025, 19:42
gemini did not start working. I used openrouter now I am atleast getting replies on the dashboard from my agent
but twitter client does not seem to work
sayonara — 29/04/2025, 19:45
gemini models are not working via curl / their openai endpoind rn for me as well if set (stream: false)
FaultyCarry — 29/04/2025, 19:46
interesting.
I am using deepseek/deepseek-chat-v3-0324:free
now I can atleast get replies on dashboard
let me check twitter
looks like these errors are mostly cause of models that I am using. but they get reflected as if it was problem on the elizaos side
sbusonero — 29/04/2025, 20:08
hey gm, building an agent with eliza.

Anyone using any ai safety tool here? What do you recommend?

I'd like to test against prompt injections and maybe having guardrails
sayonara — 29/04/2025, 20:12
seem like memory issue on your end
FeelGood2 — 29/04/2025, 20:26
bun sRuntimeError: Aborted().
[ai16z] <_orayo_>
APP
— 29/04/2025, 21:02
hey guys, why is there a error for dynamic require of util? I am using node.js 23+. Do you guys have the same error

✔ Select your database: › pglite (embedded database)
[2025-04-29 14:39:38] INFO: Selected pglite database
[2025-04-29 14:39:39] INFO: Found project by description in package.json
[2025-04-29 14:39:39] ERROR: Error importing module: Error: Dynamic require of "util" is not supported
[2025-04-29 14:39:39] WARN: Project module doesn't contain a valid default export
sayonara — 29/04/2025, 21:28
what commands did you run
Rascar — 29/04/2025, 23:00
is there any deepseek pluging for eliza v2?
sam-developer — 29/04/2025, 23:33
OPENAI_LARGE_MODEL=tngtech/deepseek-r1t-chimera:free
OPENAI_SMALL_MODEL=tngtech/deepseek-r1t-chimera:free
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_EMBEDDING_MODEL=text-embedding-004

you can use these as suggested by @FaultyCarry
ai16z-bridge-odi
APP
— 29/04/2025, 23:38
[ai16z] <stan0473> Anyone ? 😦
jbvegas — 29/04/2025, 23:58
Hey guys. I’m using more.js 23 and am able to get Eliza to start but when I go to the gui and try to get a response it crashes. It is saying there is an issue with memory. I’ve tried this on two different machines because the first one only had about 40 gigs of space on the hard drive. Second machine has plenty of space. Here are some screenshots from command js.
Image
Image
Image
cjft — 30/04/2025, 00:07
seems like machine not enough GPU / RAM for local AI, whats your hardware spec?
cjft — 30/04/2025, 00:16
https://www.reddit.com/r/LocalLLaMA/comments/1gfvsiq/hardware_requirements_for_llama_32_3b_with_full/, apparently need like 20+ gigs of VRAM, for full context LLAMA 3 8B
jbvegas — 30/04/2025, 00:18
I’ve got 4 gigs of gpu ram.
AMD Radeon Pro WX 3100
Image
[ai16z] <OpenRouter #announcemen
APP
— 30/04/2025, 01:43
FYI for those experiencing rate limit issues with 2.5 Flash, we just got more capacity on that model and it should be much better to use now.
OpsDev — 30/04/2025, 11:17
I am looking for developer
I want to build EVM AI AGENT and I already built frontend chatting page.
I need to integrate my frontend code to Eliza AI framework.
get CMC info using plugin-coingecko
Transfer, Swap, Bridge using plugin-evm
Need smart contract & Token deployment
It should be done with wallet connection in UI, NOT with private key.
sam-developer — 30/04/2025, 11:37
@OpsDev

if you take the agent id
and hit below endpoint
http://localhost:3000/api/agents/b850bc30-45f8-0041-a00a-83df46d8555d

you will be able to call agent through api and integrate it with your frontend.

I think you have to host your eliza cli version to a seperate backend endpoint if on production.

note : this is my agent id so this api endpoint might not work for you.
dming you all the api endpoint details
Image
OpsDev — 30/04/2025, 11:39
Thanks for kindly guide @sam-developer
👍
You are the best
Ahsen Tahir — 30/04/2025, 11:45
hey can anyone provide a guide for elizaOS version 0.25.9
i'm a windows user
also have wsl
the ElisaOS starter is giving me errors in better_sqlite3
sam-developer — 30/04/2025, 11:55
can you share what kind of errors you are getting
Ahsen Tahir — 30/04/2025, 11:57
[2025-04-30 05:45:40] ERROR: Error starting agent for character Eliza:
tries: [
"/mnt/c/Users/ahsen/OneDrive - FAST National University/Desktop/forVSCODE/eliza-starter/node_modules/.pnpm/better-sqlite3@11.5.0/node_modules/better-sqlite3/build/better_sqlite3.node",
"/mnt/c/Users/ahsen/OneDrive - FAST National University/Desktop/forVSCODE/eliza-starter/node_modules/.pnpm/better-sqlite3@11.5.0/node_modules/better-sqlite3/build/Debug/better_sqlite3.node",
"/mnt/c/Users/ahsen/OneDrive - FAST National University/Desktop/forVSCODE/eliza-starter/node_modules/.pnpm/better-sqlite3@11.5.0/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
"/mnt/c/Users/ahsen/OneDrive - FAST National University/Desktop/forVSCODE/eliza-starter/node_modules/.pnpm/better-sqlite3@11.5.0/node_modules/better-sqlite3/out/Debug/better_sqlite3.node",
Expand
message.txt
12 KB
sam-developer — 30/04/2025, 12:03
which command are you using
Ahsen Tahir — 30/04/2025, 12:04
pnpm one that is given in the readme on github
git clone https://github.com/elizaos/eliza-starter.git
cd eliza-starter
cp .env.example .env
pnpm i && pnpm build && pnpm start
sam-developer — 30/04/2025, 12:04
that is old
can you use the cli
can you try these
Also you might be needing bun for it

npm install -g @elizaos/cli@beta
elizaos create or npx elizaos create (since you are on windows)
select pglite upon start
bun start when inside the created project
ai16z-bridge-odi
APP
— 30/04/2025, 12:28
[ai16z] <mmmorlok> how do I deploy to prod within railway using a project started with the cli?
currently it gets stuck on the database prompt (although I have setup the POSTGRES_KEY secret + env)
hh — 30/04/2025, 16:14
hey sam thanks for that I did that and it work but my agent on the dashboard don't talk maybe do you know why ? in the env I have inserted the key api open ai
AlexShelpinOP303 — 30/04/2025, 16:17
Hi! Which node version are you using? It seems there is a known incompatibility between the latest version of bettersqlite and node 23.3 , I had to downgrade to node 20.19.1 ….
hh — 30/04/2025, 16:30
got this error [2025-04-30 10:42:37] WARN: [AgentRuntime][Eliza] No TEXT_EMBEDDING model registered. Skipping embedding dimension setup
sam-developer — 30/04/2025, 16:39
OPENAI_API_KEY did you filled this env key
sam-developer — 30/04/2025, 16:39
can you double check if you have credits on your api key
as this seems to be working me
sam-developer — 30/04/2025, 16:41
let me get back to you on this
hh — 30/04/2025, 16:48
I filled it also got credit
Image
Image
sam-developer — 30/04/2025, 16:48
can you update the cli once
hh — 30/04/2025, 16:48
what is the command ?
this one ? npm install -g @Elizaos/cli@beta
sayonara — 30/04/2025, 16:52
that should work
Ahsen Tahir — 30/04/2025, 16:54
i'm using v23.11.0
hh — 30/04/2025, 16:54
got the same error ] WARN: [AgentRuntime][Eliza] No TEXT_EMBEDDING model registered. Skipping embedding dimension setup
AlexShelpinOP303 — 30/04/2025, 16:59
Then I am sure you are facing issues because of this incompatibility , try to downgrade to 20.19.1
Ahsen Tahir — 30/04/2025, 16:59
sure
0xbbjoker — 30/04/2025, 17:56
hmm that's weird

can you check you API key, give all permissions and don't dorestricted on the openai console?
hh — 30/04/2025, 18:00
yeah I'm sure that only doest with eliza os
0xbbjoker — 30/04/2025, 18:08
if you think API key is okay then:
did you customized character?
and if so what is the order of plugins in your character?

in case you didn't changed anything and just trying to start by populating .env then I think smth is wrong with the API key and your setup on openai console.

all I have in .env and elizaos start works for me.

I have all permissions enabled on my openai key.
Image
hh — 30/04/2025, 18:09
maybe my version isnt good ? I have this one https://github.com/elizaos/eliza-starter
GitHub
GitHub - elizaOS/eliza-starter
Contribute to elizaOS/eliza-starter development by creating an account on GitHub.
GitHub - elizaOS/eliza-starter
0xbbjoker — 30/04/2025, 18:11
but you don't need that - that is for v1.

if you wanna use CLI you don't need any repo locally.

⁠❓｜tech-support⁠
the CLI will create a project repo for you
Image
hh — 30/04/2025, 18:11
aaaah I just need to do the command then
let me do it
[ai16z] <kirsty_extropy>
APP
— 30/04/2025, 18:15
Hey I'm getting this error

Error: No handler found for delegate type: TEXT_EMBEDDING

I have an anthropic key and openai key and still no luck. Any ideas?
0xbbjoker — 30/04/2025, 18:19
the Anthropic plugin does not have a TEXT_EMBEDDING model so you'll need some plugin like OpenAI.

The screenshot shows the order of plugins in your character file. This order matters because if a capability is missing in one plugin, it will fallback to the next LLM plugin in the list.

So for example, this configuration will add all the possible models from Anthropic, and then OpenAI will add the TEXT_EMBEDDING functionality that Anthropic lacks.
Image
[ai16z] <OpenRouter #announcemen
APP
— 30/04/2025, 19:01
🐳 New mysterious model! DeepSeek Prover v2
This morning, the DeepSeek team silently dropped a new 671B model on Hugging Face. Not much is known about the model yet, as it was published without a description or announcement

The previous release (v1.5) pushed the frontier forward on miniF2F and ProofNet benchmarks, using Reinforcement Learning & a Monte-Carlo search that employs an intrinsic-reward-driven exploration strategy to generate diverse proof paths.

Let’s see what v2 can do. Try it out in your own evals and let us know what you think!

Available in both free and paid variants:
deepseek/deepseek-prover-v2:free
deepseek/deepseek-prover-v2
[ai16z] <godisrupt>
APP
— 30/04/2025, 19:02
hey newbie question, how can I host ElizaOS? Because right now it runs fine on my macbook, but is it possible to mount it on Vercel? Sorry for this rather silly question
hh — 30/04/2025, 19:11
I have done all those step
and I keep getting the same error
[AgentRuntime][Eliza] No TEXT_EMBEDDING model registered. Skipping embedding dimension setup.
[ai16z] <godisrupt>
APP
— 30/04/2025, 19:14
hey eliza how is offline ?
Mel G — 30/04/2025, 19:33
Hey everyone, I am also facing issues with OpenAI. As I can see, eliza is connected to my MCP, and in the .env file, I set the values of: OPENAI_API_KEY, OPENAI_BASE_URL, SMALL_OPENAI_MODEL,MEDIUM_OPENAI_MODEL,LARGE_OPENAI_MODEL,EMBEDDING_OPENAI_MODEL. I use openrouter and and I know I have credits (and I am using ((v1.0.0-beta.38)))
Mel G — 30/04/2025, 19:49
is there something else that I should configure?
sayonara — 30/04/2025, 19:58
What’s the issue
Mel G — 30/04/2025, 20:01
OPENAI_BASE_URL=https://openrouter.ai/api/v1
SMALL_OPENAI_MODEL=anthropic/claude-3.7-sonnet  
MEDIUM_OPENAI_MODEL=anthropic/claude-3.7-sonnet  
LARGE_OPENAI_MODEL=anthropic/claude-3.7-sonnet  
EMBEDDING_OPENAI_MODEL=anthropic/claude-3.7-sonnet
OPENAI_API_KEY=sk-...
Image
sayonara — 30/04/2025, 20:03
should be OPENAI_EMBEDDING_MODEL but unrelated
wait
OPENAI_EMBEDDING_MODEL=
OPENAI_LARGE_MODEL=
OPENAI_SMALL_MODEL=
OPENAI_API_KEY=sk...
OPENAI_BASE_URL=https://openrouter.ai/api/v1
should be like this
you have setup wrong
sayonara — 30/04/2025, 20:08
railway or render; ask chatgpt how to do it
Mel G — 30/04/2025, 20:08
even with this setup, I get the same issue
sayonara — 30/04/2025, 20:09
did you restart?
the elizaos server
Mel G — 30/04/2025, 20:24
yes I did, and I can see from logs that it uses an old OPENAI_API_KEY, not the new one
Image
sayonara — 30/04/2025, 20:25
rm -rf ~/.eliza and try again; btw seems like you'd need an embedding provider which open router doesnt have
yung_algorithm — 30/04/2025, 20:26
the issue is the old .env file is still stored in that ~/.eliza location @Mel G even though u changed it in your text editor
hh — 30/04/2025, 20:30
do you have an idea why I got this plz ? [AgentRuntime][Eliza] No TEXT_EMBEDDING model registered. Skipping embedding dimension setup.
sayonara — 30/04/2025, 20:30
did you try to use a plugin that doesnt provide embedding?
like anthropic only; without openai
hh — 30/04/2025, 20:33
How I can do that ? cause I followed this ⁠❓｜tech-support⁠
yung_algorithm — 30/04/2025, 20:46
@hh just make sure u have both openai and anthropic keys in your .env file bro
hh — 30/04/2025, 21:15
these two are setup but still got the same error actually [AgentRuntime][Eliza] No TEXT_EMBEDDING model registered. Skipping embedding dimension setup.
Image
yung_algorithm — 30/04/2025, 21:15
try this @hh
your old .env file is still liekly being referenced. you need to drop the old db
hh — 30/04/2025, 21:21
did this and still the same problem
I'm on windows I do all of this in wsl
npm install -g @Elizaos/cli@beta
elizaos create or npx elizaos create (since you are on windows)
select pglite upon start
bun start when inside the created project
yung_algorithm — 30/04/2025, 21:23
what version eliza are you running
hh — 30/04/2025, 21:27
idk cause when I do this npm install -g @Elizaos/cli@beta it's installing eliza where I can check ?
sayonara — 30/04/2025, 22:13
try with elizaos start within the folder?
sayonara — 30/04/2025, 22:14
elizaos --version
hh — 30/04/2025, 22:16
1.0.0-beta.41
sayonara — 30/04/2025, 22:16
try this @hh ? also where did you place your .env
hh — 30/04/2025, 22:18
I got this when I do elizaos start
[2025-04-30 16:47:40] ERROR: Error details: Database adapter not initialized. The SQL plugin (@Elizaos/plugin-sql) is required for agent initialization. Please ensure it is included in your character configuration.
[2025-04-30 16:47:40] ERROR: Stack trace: Error: Database adapter not initialized. The SQL plugin (@Elizaos/plugin-sql) is required for agent initialization. Please ensure it is included in your character configuration.
before I was doing bun start
sayonara — 30/04/2025, 22:19
okay try this

rm -rf ~/.eliza

go to your project folder

elizaos start
funboy — 30/04/2025, 22:30
Some one have tested the live chat interaction on X (twitter) ?
I mean, It's included in the twitter-client ? @shaw
hh — 30/04/2025, 22:31
I'm still waiting localhost to refresh it's like refreshing in loop
hh — 30/04/2025, 22:43
ok nice this time I get this
Thank you a lot @sayonara
after that do you know how I can deploy that agent on twitter ? only need to add api key twitter in the .env right ? @sayonara
LemonS — 30/04/2025, 23:48
can I get some help running a custom client? im using direct client as example
Im getting a response using generateMessageResponse(), in the response I see the action I need to invoke in action, but then I don't know how I should actually invoke that action, I alter run runtime.processActions(), but it doesnt seems to be doing anything
Odilitime — 01/05/2025, 00:07
In 0.x or 1.x?
LemonS — 01/05/2025, 00:47
0.25.6
Odilitime — 01/05/2025, 00:54
ok so client-direct's message endpoint, calls processActions here
https://github.com/elizaOS/eliza/blob/ef7d22353729bc4fa3d8d8a51a00d6544064b873/packages/client-direct/src/index.ts#L320
GitHub
eliza/packages/client-direct/src/index.ts at ef7d22353729bc4fa3d8d8...
Autonomous agents for everyone. Contribute to elizaOS/eliza development by creating an account on GitHub.
Autonomous agents for everyone. Contribute to elizaOS/eliza development by creating an account on GitHub.
responseMessage is passed by reference and can be modified by actions
if the LLM doesn't decide to call any actions, nothing will be done
LemonS — 01/05/2025, 01:04
ok, let me check if i get this ok, first I get an initial response in line 291, that response includes the actions, at least thats what I see debugging, then when I call processActions, should I get the actions result inside the message in line 318?
Odilitime — 01/05/2025, 01:06
if the action has any results
I'd say most don't, few actions will update the response
most mess with memories/knowledge
LemonS — 01/05/2025, 01:12
I have a custom action returning text, so another option is that the response from line 291 is updated? should I do something to get the updated version? if I test the action in the web client I get first an initial message saying something like "ok, ill do that", stating the action, and then a follow up message with my actual action response, but what im trying to do im missing that second message
Odilitime — 01/05/2025, 01:41
https://github.com/elizaOS/eliza/blob/main/packages/plugin-bootstrap/src/actions/continue.ts#L92
GitHub
eliza/packages/plugin-bootstrap/src/actions/continue.ts at main · ...
Autonomous agents for everyone. Contribute to elizaOS/eliza development by creating an account on GitHub.
Autonomous agents for everyone. Contribute to elizaOS/eliza development by creating an account on GitHub.
might be of some use, continue action can return multiple messages at once
the message pipeline can put a delay between two repsonses
it returns them all at once just like a http response
I don't think you'll be able to get client-direct to fire off a later response (if that's what you're trying to do) but timers with twitter/discord/telgram could work
1.x has some events based stuff and websockets for the chat interface
LemonS — 01/05/2025, 01:45
I got an idea, instead of tring to read that result message, just send it when its generated, inside the async function in processActions, im tring that haha
[ai16z] <OpenRouter #announcemen
APP
— 01/05/2025, 02:22
⚡️ NEW: Inception's Mercury Coder, the first diffusion LLM
⚡ Highlights
Rivals GPT-4o Mini and Claude 3.5 Haiku in code quality.
Blazing-fast performance: seeing 300+ TPS right now
Diffusion architecture means parallel token refinement, with potentially fewer hallucinations and improved reasoning.

Try it here 👉 https://openrouter.ai/inception/mercury-coder-small-beta

More info on X, including Inception's announcement: https://x.com/OpenRouterAI/status/1917677801211322752 @here
OpenRouter (@OpenRouterAI) on X
1/ ⚡️ Exciting new model from @InceptionAILabs: Mercury Coder

The first diffusion-powered LLM on OpenRouter.

Rivals GPT-4o mini & Claude 3.5 Haiku in quality, yet runs much faster, with twice the throughput: 320 TPS right now!

X•01/05/2025, 01:59
[ai16z] <subhankar141202>
APP
— 01/05/2025, 03:03
Hey! I have a question, i have almost 1000 of agents when i am trying to query all of them at a time, then I get a pg pool error "connection timed out", and start failing my task. So how can i use this for lots of agents or do i need to use a different adapter for this.
[ai16z] <odilitime>
APP
— 01/05/2025, 03:04
what adapter are you using
[ai16z] <subhankar141202>
APP
— 01/05/2025, 03:04
postgres
[ai16z] <odilitime>
APP
— 01/05/2025, 03:05
on 0.x ?
[ai16z] <subhankar141202>
APP
— 01/05/2025, 03:05
The latest one
[ai16z] <odilitime>
APP
— 01/05/2025, 03:05
well we have a beta of V2 which is 1.x
do you mean the latest stable release? which is 0.25.9
[ai16z] <subhankar141202>
APP
— 01/05/2025, 03:07
Its 1.0.0-beta
[ai16z] <odilitime>
APP
— 01/05/2025, 03:10
oof that's tough, I don't have any magic for that one
you're in the terrirtory of needed to optimize queries, and checking indexes of the queries
wonder if you could just increase the timeouts initiailly to get you some more head room
but you'll need to profile and analyze what's eating up postgres's time
[ai16z] <OpenRouter #announcemen
APP
— 01/05/2025, 03:30
An update on the upstream Vertex token counting issue with Gemini 2.5 Pro and Flash Preview models: The Vertex team has finished the rollout of the fix, and we have now re-enabled the model.
[ai16z] <OpenRouter #announcemen
APP
— 01/05/2025, 05:12
We're temporarily disabling caching on Gemini 2.5 Pro Preview as we evaluate usage and costs from upstream (AI Studio and Vertex) to ensure users aren't being over-billed.
shaw — 01/05/2025, 06:44
hmm what is your postgres? this sounds like connection pooling headache thing, if you're using pgbouncer should be ok

1000 agents, sounds cool
Thanh — 01/05/2025, 09:14
Hi there
I cannot make agent work with knowledge
"knowledge": [
"Rokie is a superman. He loves peace He fly around the world everyday He dont eat"
],
Image
Anyone pls help me on this
Odilitime — 01/05/2025, 09:28
https://eliza.how/docs/0.25.9/faq#memory-and-knowledge-management maybe
Frequently Asked Questions | eliza
What is Eliza?
[ai16z] <dansyk.>
APP
— 01/05/2025, 09:30
hello, how to startup eliza new release
i tried to run twitter but it stuck
Thanh — 01/05/2025, 09:52
I have not changed much things. Just install elizaos/cli@beta, create a project, add .env param: open ai key, postgresql server, then add that knowledge into src/index.ts
Image
Image
Odilitime — 01/05/2025, 10:31
Oh that’s 1.x
