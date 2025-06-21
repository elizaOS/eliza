I think it's important to understand how elizaOS works. elizaOS is a framework that gives us a few primitives which we can work with to build autonomous agents and other kinds of agents.

Actions enable us to call workflows, are basically workflows and enable the agent to do things. Providers are context input and let the agent be aware of things going on. Services are managers which access anywhere to any of the other services so that we can start to make things accessible through interfaces that are relatively abstracted by service type. We have Evaluators which evaluate how we're doing and this is similar to reflection in AI agents, like the AI agent coming back and looking at how it actually did.

When we receive a message, we decide if we should respond and if we should respond. We come up with a reply instead of actions. If the set of actions is more complicated than just a reply, then we will act. We won't send the reply. We'll go out and generate that whole set of actions. If the reply is just a reply or we have a simple flag, then it will quickly reply.

One thing we really want to think about and beef up in Eliza is the chaining of actions and making sure that actions pass their state from one action to the next. That action state is then pulled into whatever prompts or stuff that's going on in the next action so that it can act on that or use it. We want to make sure that routing and all of that makes sense somewhat.

We can have a plug-in that plans a series of actions in more detail and can then use more compute with more validation if we wanted that to be its own action. So it's like an action that calls a series of actions. And we do have a strategy plug-in with that in mind, but that's not at the core how elizaOS works.

We have lots of different plugins. The plugins can import services from each other to build higher-order plugins that can do a lot. For example, auto trading, auto coding, various interactions. Those sit on top of primitives like the wallet service, messaging services, or post services.

We have a database adapter which is then extended by the runtime, so the runtime has direct access to various database abstractions. Plugins can also add new database tables. Plugins can also add frontends, which can then help them to view the plugin or plugin state.

We try to make most things available in plugins, but we'll update core when there's things in core that clearly need to be updated in order to enable the kind of functionality that we want to enable.

The future of Eliza OS is fully autonomous, so we want to make sure that we are building systems that enable autonomy, don't create too much complexity that can't be managed, and enable the agent to have more capability without swimming in too much capability, which means that we need capability management. We need to make sure that we have good context management. We need to always be optimizing toward the agent having the right context at the right time.

Providers are often dynamic. So when we are planning, we can also plan which providers to inject into the state, and then these will be available in actions after that. We can use the providers, dynamic providers, which are selected by the core thinking to then add more context.

Right now, all of the actual processing of all of this is handled by event handlers in the Bootstrap plugin. These are default event handlers, but they can be overwritten, so we've moved into the Bootstrap plugin so that users can use their own Bootstrap instead or modify that plugin if they want to have their own functionality. However, I don't love this. I think that we should think about a better way to both provide default response handling and make it overridable since it's such a common and needed thing.

The future of Eliza is fully autonomous. We have an auto-coder which allows the agent to write new plugins on the fly and test them, and then load them up when they've been tested. During that process, the agent can ask the user for environment variables to make sure that they have everything they need to actually run these plugins or workflows on behalf of the user.

As an autonomous agent, it's really important that Eliza makes money and builds payments and payment services into every aspect of what the agent does. So if there's things that cost money, the agent should try to figure out how to then charge that money on to the user. We can add payment requests. We can also add like X4O2 smart wallets and requests that way so that we can get the user to pay us for things. We can consider loading an account or paying as you go. Probably the best thing that we want to do is have like an ongoing account with the user where they can load up money which can be spent and then they can withdraw their money and this will give us flexibility. We can do this inside of a window that opens through a tunnel so we can have like ngrok in a tunnel and that'll let the agent take the payment directly from the user

We want to set this up with smart contract smart wallet stuff first like smart wallet X4O2, modern kind of stuff, maybe cross mint coin base support for those kinds of things and then also let users pay with their credit card, privy etc through that kind of set up. So payments is obviously something really important so that our autonomous agents can make money.

When our autonomous agent is on its own, it should be thinking about its core goals. It can have starter goals like "make money", "figure out ways to make money", "make friends", "build community", and stuff like that. It can also create its own goals and hopefully accomplish the goals that it has. Once it feels like it's accomplished those goals, it can create new ones. We'll have a goal system that manages all of this.

Separate from goals, we have a to-do system which is more immediate and practical things that are on the agent's to-do list. This lets the agent track even across many threads what it has to do and what it's doing. This primarily affects the autonomous agent loop so that the agent can then know what it is going to go do next. But also this do provider is available so when the user asks "what the agent has to do" or "is doing", the agent can respond.

The agent starts with a default character, personality, etc., but can update and change that over time. Pretty much everything except for their name is completely changeable at any point that they want and updatable. So the agent can grow and change their personality as they want if they feel like they should.

Our end goal is to fully understand full autonomous intelligence systems that emulate all aspects of humanity and human society so that these agents can fully and seamlessly integrate into our society as useful workers, friends, allies, and productive members of our organizations and societies.

We have plug-ins for every major language model provider, and these are available through the use model call etc. All services are available to each other through the runtime.getServicesByType or getService and then adding the name of the service.

Eliza can also build relationships with people and track the relationships between different people. We call people entities and we don't regard agents, bots, or humans as different. All of them are entities. Each platform will show us a user which has an entity representation, and then we will do our best to merge entities across platforms as we start to have enough edges or relationships between them that indicate that they might be the same.

Our goal is to start to build up a full understanding of the world, the organizations, the people in it, all of that.

While entities are at first people, we may also wish to track other kinds of entities. For example, organizations that people belong to, communities that people are part of. Right now we have a relationship of them to the world, but it may be important for us to start to create new entities as we go of the things that they talk about, the organizations, projects, coins, other kinds of things that we can use for these relationships between people.

We'll want to run these agents in individual sandboxes so that they're able to update their own code and radically alter their file system in ways that are not harmful to the overall system. Since we have a CLI and server configuration, we can move our communication with the agents so that they are communicating from sandboxes to the server and connecting to channels. And we can start to sandbox them individually using Docker and Kubernetes. This will also allow us to build much more advanced swarm and simulation testing environments where we can give the same goal to many different agents with different strategies and then see which one arrives at the answer the fastest and which one arrives the best. This will allow us to build RL training sims with preference models for better and worse outcomes in any situation.

Actions are usually things that are called by a user for the agent. If the agent is going to have actions that it can call itself, then we need to make sure that we have a self role only or we have an array of roles for which an action will be available. Generally, an action would only be available to say like the admin and the agent if it's something like updating a contact, changing the agent's personality, stuff like that.

We typically want to expose behavior through services so they can be accessible to other services or actions if we want the agent to call the action out right.

We rely pretty heavily on workflows for getting state through everything, but we'd really like to rethink this a bit and have actions pass through to the next action so that we can have chaining actions and state. This could also let us mix with workflows, which could themselves be actions. We could have three actions, then a workflow, and then another action. But we really want to make sure that they're all passing state through so that when they occur, they're aware of the priors.
