# advanced trading by moon dev

- this plugin will include a ton of helpful trading functions so that agents can buy, sell & manage risk. i use these for onchain solana bots
- while everything is currently in python i will later convert to ts if needed or i will add a shell (researching best approach)

how to use
1. config.py controls the solana contract that is being traded, size, etc.
2. run from bot.py, there are a bunch of different 'actions' for the trading, like buy under x price, while sell over y price. or a breakout option or stop loss.
3. nice_funcs has a ton of helpful functions to algo trade onchain solana
4. if the ai needs ohlcv data they can get it on get_ohlcv_data.py

things needed in dontshare.py (add to .gitignore and never share this file)
1. sketch but private solana key if you want them to trade
2. birdeye api key
3. rpc_url (i use helius)

Completed 12/21

1. nice_funcs.py - a ton of solana onchain infastructure to trade. ive been using this code for all my onchain bots but believe ai will utilize them better.

2. bot.py - a simple script to allow any ai to call actions like 0 - close a position 1- open a position 2- sell if price falls under x price (stop loss) 3- buy if price goes over y price (breakout) 5- buy if under X price and sell if over Y price (market maker)

3. get_ohlcv_data.py - an easy way for ai to get any ohlcv data anytime. every great trade starts with data so this is essential








==== studying eliza and resources


trades: https://app.eliza.systems/trades
hi

top 5 wallets
https://solscan.io/account/9YnQdCWDAQRfQYm5HvRzoPgc5GRn8fyhsH2eru8nfsxG
https://solscan.io/account/8CaTuoD1r6CzR1mu6ueTDvjNpLj7sq5nWafDLymkQ4jH
https://solscan.io/account/CX3Nx8NPv8ZVqiBS7eLHBjrcRk69o7k1Z5q8Go1Uqc2z
https://solscan.io/account/G8AFH5qJ3eGx7vKFZsjo4LmxYCgTQ45WFb5FErq7PT1r
https://solscan.io/account/6rg2rfZ6Sim6j63LXvaLgbWicVGWhJUYHkCxgSHZBCqs

resources
- docs: https://ai16z.github.io/eliza/docs/intro/#
- eliza dev playlist: https://www.youtube.com/watch?v=ArptLpQiKfI&list=PLx5pnFXdPTRzWla0RaOxALTSTnVq53fKL
- each ai can launch a token: https://www.daos.fun/
    - virtuals.io is the base one: https://app.virtuals.io/
- listen: https://x.com/weremeow/status/1851365658916708616
    https://x.com/0xtechnoir/status/1853907223526920461
- watch community call: https://www.youtube.com/watch?v=iQ0UFGREhJI
-read this dialougefounder ai16z 100 agents https://www.panewslab.com/en/sqarticledetails/bn6f9u6m.html
- https://shaw.wtf/Crypto-Is-Good/
- https://shaw.wtf/
- typescript: https://github.com/moondevonyt/learn-typescript-from-python


models
https://lmarena.ai/ - go to arena to see whos top dawg
https://context.ai/compare/o1-preview-2024-09-12/gemini-1-5-pro
    usage: https://console.cloud.google.com/apis/api/generativelanguage.googleapis.com/cost?project=gen-lang-client-0134479047


- claude rn is the best
- grok is good for this type of stuff
- gemeni is technically the best model out rn

cloud gpus
- lambda of course, most exp
- prime intellect cheaper but works cheaper
- https://app.hyperbolic.xyz/compute
model selection for AFI
    - gemini + rag for now
        - maybe use llama or a smaler cheaper modle for small stuff, f it just use gemini sma


notes
- Llama 70B is used for ai16z - suggested to be optimal for training character trading bots
- Truth Terminal uses Claude Opus
- nvm use 23 or nvm install
cd docs
code2prompt ./
code2prompt src/
- they use llama cloud for their bots
- fork this so i can just work on my own and keep changes seperate
- use claude and grok (by x)
- gemini has a 2m context windwo
- build our mods and community support, could be tutors
- actions: predefined behaciours that agents can execut in reponse to messages, enabling them to perform and interact iwth external systems
- clients act as interfaces between agents and platforms likediscord twitter and telegram
- providers supply agents with xontextual info including itme awareness, user relationshpsand data from extrenal source
- evaluators assess and extract info from convos helpng agents tracks goals build memory and maintain context awareness
- character files are json files define personality knowledge and behavoi of each ai agent
- memory system featurs a sophistiated memoru mangement system that utilizer verctor embediinngs and relational database storage to store and retreive info for agents
- The capability to do so is there, it's ultimately up to the AI agent on whether or not it will. TURN OFF
- they havea  tons of plug ins but bootcstrat is where its at... thats all the code they provided
- extenal integrations - they have a take order for trading
- we can also make custom actions here; https://ai16z.github.io/eliza/docs/core/actions/
- they also give access to trustscore system: https://ai16z.github.io/eliza/docs/guides/advanced/
    - more on trust score: https://ai16z.github.io/eliza/docs/advanced/trust-engine/
    - also speech with eleven labs is here
- autonomous trading: https://ai16z.github.io/eliza/docs/advanced/autonomous-trading/
- extracting tweets from a user is userful its a script for training at the bototom: https://ai16z.github.io/eliza/docs/guides/local-development/
- supabase is a cloud hosted postgres for dployment shaw said ppl use
- auto client is the trading client we would use: https://ai16z.github.io/eliza/docs/packages/clients/
- https://www.youtube.com/watch?v=XenGeAcPAQo


CONFIGUTATION: https://ai16z.github.io/eliza/docs/guides/configuration/

LEARN TYPESCRIPT FOR ELIZA: https://chatgpt.com/share/6762f33c-0cd0-800e-8fd6-1ec653feb345

contribute to project
- Contribute to the autonomous trading system and trust engine: Leverage expertise in market analysis, technical analysis, and risk management to enhance these features.

12/19

- building afi.xyz artificial financial intelligence for the people fuck wall street.
- learned typescript today, so we ready to build & contribute
- https://www.youtube.com/watch?v=XenGeAcPAQo finishing up the day with finishing this training and then will watch next one.

step 1: learn typescript

12/17 taking the school
- cod to prompt tool in here code2prompt
- he uses claude/grok > openai
- npm install langchain is node package manager, pip essentially
- pnpm is the performance node packamge manager

12/10-
- can interact with discord, twitter, and solana and eve..
- these can possible engage in trading strategies because they will be able to interact in discords and twitters in order feel sentiment
- supports openai and tropic
- i got oi data
- i got liq data
- solana plug in??
- coinbase commerce so the agent can have OHLCV data for all coinbase tokens.
* advanced/autonomous-trading and advanced/trust-engine docs to manage agent trust scores, token recommendations, and risk profiles.
* explore auditomioze trading docs
* get this agent its own discord channel and communicate with another agent to lock in on quant, using my framework and we can watch them in their own chanel
* since we built the GE that outputs millionaires of strats, then we do rigors testing, we literally have a pool of hundreds of working strats that the AI agents can pick from…














CONVERTING FROM PYTHON TO TYPESCRIPT

## step 1: make the python usable by typescript with a shell.

import { PythonShell } from 'python-shell';

class TradingBridge {
  async executeBot(command: number): Promise<void> {
    const options = {
      mode: 'text',
      pythonPath: 'python3',
      pythonOptions: ['-u'], // unbuffered output
      scriptPath: './packages/plugin-trading/python_trading/',
      args: [command.toString()]
    };

    console.log('🚀 Calling Python trading bot...');

    return new Promise((resolve, reject) => {
      PythonShell.run('ezbot.py', options, (err, results) => {
        if (err) {
          console.log('❌ Error running trading bot:', err);
          reject(err);
        }
        console.log('✨ Python bot results:', results);
        console.log('🌙 Moon Dev's trading magic completed!');
        resolve();
      });
    });
  }
}

## step 2: if needed

Here are the key trade-offs between using Python with a shell vs. rewriting in TypeScript:
Benefits of Keeping Python + Shell:
✅ Faster development - your code already works
✅ Python has excellent numerical/scientific libraries (numpy, pandas)
✅ Most trading/quant libraries are Python-first
✅ Easier to find examples/documentation for crypto trading in Python
✅ Can still integrate with TypeScript system via shell
Benefits of Rewriting in TypeScript:
1. ✅ Better performance (no shell overhead/context switching)
2. ✅ Type safety across your entire application
✅ Easier debugging (single language stack)
✅ Better IDE support/autocomplete
✅ Simpler deployment (no Python dependency)
My Recommendation:
Start with the Python shell approach since:
You already have working code
Trading systems prioritize reliability over pure performance
The shell overhead is negligible for trading operations
You can gradually port functions to TypeScript if needed later
Only consider rewriting if you:
Hit performance issues with the shell approach
Need deep integration with TypeScript features
Want to remove Python as a dependency entirely
For now, I'd suggest focusing on making your trading logic robust rather than rewriting working code! 🎯