import { GitHubClientInterface } from "./client";

const githubPlugin = {
    name: "github",
    description: "GitHub client",
    clients: [GitHubClientInterface],
};
export default githubPlugin;
