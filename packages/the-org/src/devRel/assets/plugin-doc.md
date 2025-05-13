DEV REL Agent
Overview
Users are not always familiar with Plugins and how they work, or our process. Especially since it’s recently changed in the last ~3months. It’ll be very important that there are clear guidelines on what these are, so folks know what to do and where to go. Especially as folks are onboarding for the first time. Along with a refresher for many already in the community as they don’t live and breathe this information daily.

User story 1: “I’m new to elizaOS, and need to understand what Plugins are and how they work”
User story 2: “I want to build a Plugin, what are my next steps? I don’t understand”
User story 3: “I want to know which Plugins I should use based on the agent I’m building”

High level flow - As a user I’m either looking to build a plugin (generally B2B), or I’m looking to use a plugin (generally B2C)

Iteration 1: DevRel agent will help answer questions about Plugins on discord (private channel) and TG (private channel) and internal teams to get answers on B2B conversations that BD teams are having etc. This will act as source of truth on all t hings plugins.
Iteration 2: Roll out in developer server/tech-support, TG builder chat/ dev-support, and accessible for internal teams to get answers for B2B conversations that BD teams are having, etc. This will act as a source of truth.
Phase 1: Build Plugins
Plugin development on ElizaOS framework is permissionless and scalable. We do this by allowing teams to deploy and maintain Plugins on their own respective GitHub repositories.

Whether you are looking for inspiration, or finding a plugin you’d like to use or looking for what’s available, to make discovery of Plugins easy for everyone; Plugins have a home here https://elizaos.github.io/registry/
An easy one location for all plugins.
User story 1: “I’m new to elizaOS, and need to understand what Plugins are and how they work”
User story 2: “I want to build a Plugin, what are my next steps? I don’t understand”

Frequently Asked Questions

How to add Plugins to ElizaOS Plugin Registry?
Once you’ve hosted your plugin in your repo, please add an issue to the Plugin repo pointing correctly to your repository, and add a modification to the registry. Once this is done, please submit PR to edit the registry here https://github.com/elizaos-plugins/registry

Once the review is successfully complete, your Plugin will be visible in the ElizaOS Plugin Registry here https://elizaos.github.io/registry/

How long does the Registry PR review process take?
It’s hard to say, depending on team bandwidth. We suggest to plan as it takes up to a week, so please plan accordingly

How long does the Plugin Review take?
Review is no longer required for Plugins as they are not merged into the main repository.
Plugins will be maintained and owned in their respective GitHub repositories. However, if you’d like them to be displayed in ElizaOS Plugin Registry, please submit a PR here https://github.com/elizaos-plugins/registry
What is the Plugin release procedure? Or Are maintainers able to release a new version of code by themselves?
To update your Plugin, please push the updated code to the default branch on your repo. Since this is already pointing to the correct repository on the ElizaOS Plugin Registry, this will always reflect your most updated code.

How frequently can the maintainers release a new version?
Maintainers can release their own plugin updates as frequently as they’d like. We ask that the updated code be pushed to the default branch on your repo.
Having a plugin listed in the registry does not require it to be under elizaos-plugins organizations. As part of the current transition state, some plugins are published under the elizaos-plugins organization and some are not. In a future state, only plugins considered “official plugins” will remain in elizaos-plugins.

What are best practices when submitting a Plugin PR? Is there a good example that I can follow?
Ensure your permissions are set right. In a scenario where maintainers run into a conflict, they need to have edit access to your PR to be able to resolve the conflict.
Here’s a link on how to do that https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/allowing-changes-to-a-pull-request-branch-created-from-a-fork

Ensure your plugin Readme documentation contains all the information for a potential user, so they are able to fully understand and make an informed decision on how to utilize it to its full potential.

Good example of a PR https://github.com/elizaos-plugins/registry/pull/35
PR structure - clean commit, clear description, proper folder paths
These will help on the DevX side and improve adoption of the plugin
If you are able to, add a how-to step by step tutorial video on how to use your plugin, along with various scenarios and how to configure or navigate them.

Do you have some sort of a plugin template repo that I can get started with and build off of?
starter template for plugin- https://github.com/elizaOS/eliza/blob/v2-develop/packages/plugin-starter/src/index.ts

I built a plugin and submitted a PR, how can I get the review expedited?
Please post your PR in the following channel in elizaOS developer server to help provide additional visibility. We generally suggest planning upto a week in advance, in case there are an unexpected number of PR submissions causing delays with review times.
https://discord.com/channels/1051457140637827122/1323745969115893780

Phase 2: Use Plugins
User story 1: “I’m new to elizaOS, and need to understand what Plugins are and how they work”
User story 3: “I want to know which Plugins I should use based on the agent I’m building”

Frequently Asked Questions
Which plugin should I use based on my use case?
This will vary depending on what you are trying to build. Could you share more on what you are building?

We are trying to run the https://github.com/elizaos-plugins/client-xmtp plugin, but it doesn't seem to receive messages. Did someone have experience running it?
//answer TBD
