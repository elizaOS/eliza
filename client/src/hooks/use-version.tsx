import { useEffect } from "react";
import { useToast } from "./use-toast";
import info from "@/lib/info.json";
import semver from "semver";
import { ToastAction } from "@/components/ui/toast";
import { NavLink } from "react-router";

export default function useVersion() {
    const { toast } = useToast();

    async function getLatestRelease(repo: string) {
        const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;

        try {
            const response = await fetch(apiUrl, {
                headers: {
                    Accept: "application/vnd.github.v3+json",
                    "User-Agent": "fetch-latest-release",
                },
            });

            if (!response.ok) {
                throw new Error(
                    `Failed to fetch latest release: ${response.status} ${response.statusText}`
                );
            }

            const data = await response.json();
            const latestVersion = data.tag_name;
            return latestVersion;
        } catch {}
    }

    const compareVersion = async () => {
        try {
            const latestVersion = await getLatestRelease("elizaos/eliza");
            const thisVersion = info?.version;
            if (latestVersion && thisVersion) {
                if (
                    semver.gt(
                        latestVersion.replace("v", ""),
                        thisVersion.replace("v", "")
                    )
                ) {
                    toast({
                        variant: "default",
                        title: `New version ${latestVersion} is available.`,
                        description: "Visit GitHub for more information.",
                        action: (
                            <NavLink
                                to="https://github.com/elizaos/eliza/releases"
                                target="_blank"
                            >
                                <ToastAction altText="Update">
                                    Update
                                </ToastAction>
                            </NavLink>
                        ),
                    });
                }
            }
        } catch (e) {
            console.error(`Unable to retrieve latest version from GitHub: ${e}`);
        }
    };

    useEffect(() => {
        compareVersion();
    }, []);

    return null;
}
