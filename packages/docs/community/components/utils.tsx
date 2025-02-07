import useDocusaurusContext from "@docusaurus/useDocusaurusContext";

export function hexToRgb(hex: string) {
    hex = hex.replace("#", "");
    const bigint = Number.parseInt(hex, 16);
    const r = (bigint >> 16) & 255;
    const g = (bigint >> 8) & 255;
    const b = bigint & 255;
    return `${r}, ${g}, ${b}`;
}

export function useGithubAccessToken() {
    const { siteConfig } = useDocusaurusContext();
    return siteConfig.customFields.GITHUB_ACCESS_TOKEN;
}
