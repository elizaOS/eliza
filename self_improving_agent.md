# Self Improving Agent

I have several plugins which I'm trying to put together to make sure that my agent framework can successfully perform this fairly complicated task.

I need to research the dependencies and code before writing a plugin. Then I need to go through the procedure of planning, writing, linting, validating, building, and testing the plugin. After the proof of concept, I need to create the full implementation plan and repeat those steps until the plugin does everything that I want it to do.

You need to create some realistic real-world scenarios for the plug-in, identify the environment variables that I'll need to complete the task, and get those real-world scenarios done. Then I'll need to go to the user and ask for those environment variables so that when I go to test the plug-in, I have them available to me.

When do I go and ask the user? Should I ask them at the beginning? Should I ask them when I need them? I need to make sure that I have this loop part figured out. It's one of the more complicated parts that we'll need to really think about and plan out.

For research, I have the Research plugin which also leans on browser base.

I need to modify my auto coder plug-in to first perform the research, then store that research in the knowledge base using the knowledge plug-in so that it's retrievable, as well as any other information we may wish to pull. I need to then go and pull any docs so I should probably get a set of links from the research because I need to go and pull all of the relevant docs into knowledge for this project. I will then want to make sure that my secrets manager goes and takes whatever secrets that I think that I need and requests them from the user. But I don't want that to be blocking. I'd like it to continue to develop until we get to the point where we're erring and we actually need those secrets. Then it can alert the user that it's no longer able to continue. That'll have to be something that we think of an account for is like, what's the point at which we absolutely need the secrets? We can also make sure that we know what secrets we need and we track that.

Once the plugin is coded and fully tested, we need to make sure that we engage the user and come up with some real-world scenarios with the smallest unit of test measurement for whatever we're testing. Like if we're testing DeFi, we want to test the smallest amount of money and we want to try and keep the user in the loop on that.

We also want to make sure to keep the user in the loop on how things are going after they've requested the creation of a new plugin.

We're going to focus on updating existing plugins that exist within the registry. We'll want to use the plugin plugin manager to clone repos and work on them, commit new code, and make new branches, and push to a new pull request. All that should be like just part of a single action where we can make a pull request and then send it back to the user.

The whole scenario that we're trying to achieve here is that we're going to create or test many plugins, some plugins created from scratch and some plugins which are already works-in-progress. These plugins will be from a file path that exists or from a GitHub repo and branch.

We will then need to upgrade that with all of the specifications the user specifies, do any necessary research, and finally write all the code, upgrade, and test it.

Then we'll need to actually publish the PR and send that PR back to the user.

I think all this can be handled in the auto coder as the highest-level thing here, which is leaning on all of these other plugins. It can keep a list of running code projects which are available in a provider, so that if the user asks how the projects are doing they can see. Then the user can update projects, add their feedback to a project which will get injected in, and then can continue the auto coder from wherever it is, similar to how other code agents work, etc.

The goal of the Eliza agent is to self-improve by writing and upgrading plugins

The agent can search for, create, upgrade, run and publish ElizaOS plugins.

Tests are run by 'elizaos test' which runs the unit tests with vitest and the e2e tests through the plugin

Frontend tests are run with Cypress

# Plugin Creation Flow

1. Use the research plugins to research dependencies, similar code etc. We're especially interested in npm, Github, developer docs, etc.

2. Plan an MVP proof of concept

3. Clone the plugin-starter

4. Implement the code

5. Run tsc and fix all linter errors and fix all issues until moving onto next step

6. Run eslint and fix all linter errors and fix all issues until moving onto next step

7. Run 'bun run build' and make sure it all works and fix all issues until moving onto next step

8. Run 'elizaos test' and make sure it works and fix all issues until moving onto next step

9. Plan full implementation of the plugin

10. Run tsc and fix all linter errors and fix all issues until moving onto next step

11. Run eslint and fix all linter errors and fix all issues until moving onto next step

12. Run 'bun run build' and make sure it all works and fix all issues until moving onto next step

13. Run 'elizaos test' and make sure it works and fix all issues until moving onto next step

14. Gaslight the model and tell it that there's still more to do to complete all acceptance criteria

15. Run tsc and fix all linter errors and fix all issues until moving onto next step

16. Run eslint and fix all linter errors and fix all issues until moving onto next step

17. Run 'bun run build' and make sure it all works and fix all issues until moving onto next step

18. Run 'elizaos test' and make sure it works and fix all issues until moving onto next step

# Plugin Update Flow

1. Use the research plugins to research dependencies, similar code etc. We're especially interested in npm, Github, developer docs, etc.

2. Plan full implementation of the plugin

3. Run tsc and fix all linter errors and fix all issues until moving onto next step

4. Run eslint and fix all linter errors and fix all issues until moving onto next step

5. Run 'bun run build' and make sure it all works and fix all issues until moving onto next step

6. Run 'elizaos test' and make sure it works and fix all issues until moving onto next step

7. Gaslight the model and tell it that there's still more to do to complete all acceptance criteria

8. Run tsc and fix all linter errors and fix all issues until moving onto next step

9. Run eslint and fix all linter errors and fix all issues until moving onto next step

10. Run 'bun run build' and make sure it all works and fix all issues until moving onto next step

11. Run 'elizaos test' and make sure it works and fix all issues until moving onto next step
