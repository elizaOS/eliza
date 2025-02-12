import type React from "react";
import { useState, useEffect } from "react";
import { Accordion } from "./Accordion";
import { StatCard } from "./StatCard";
import { THEME_COLORS } from "./Contributors";
import { hexToRgb, useGithubAccessToken } from "./utils";
import ScoreIcon from "./ScoreIcon";
import Summary from "./Summary";
import Hero from "./Hero";

export interface GitHubItem {
    html_url: string;
    title: string;
    created_at: string;
    bullet?: string;
}

export interface StatCardProps {
    title: string;
    value: number;
    style?: React.CSSProperties;
}

export interface AccordionItem {
    data: GitHubItem[];
    total_count: number;
    state?: string;
}

export enum BULLET_COLOR {
    OPEN = "#1A7F37",
    CLOSE = "#D1242F",
    MERGE = "#8250DF",
}

const initializeAccordionItem = (): AccordionItem => ({
    data: [],
    total_count: 0,
});

const Contributions = ({
    contributor,
    onBack,
    darkMode,
    activitySummary,
    score,
}) => {
    const githubAccessToken = useGithubAccessToken();
    const [commitsData, setCommitsData] = useState<AccordionItem>(
        initializeAccordionItem(),
    );
    const [prsData, setPrsData] = useState<AccordionItem>(
        initializeAccordionItem(),
    );
    const [issuesData, setIssuesData] = useState<AccordionItem>(
        initializeAccordionItem(),
    );
    const [openAccordion, setOpenAccordion] = useState<string | null>(null);

    const [commitPage, setCommitPage] = useState(1);
    const [prPage, sePrPage] = useState(1);
    const [issuePage, setIssuePage] = useState(1);

    useEffect(() => {
        const fetchContributorStats = async () => {
            try {
                await fetchCommits(commitPage);
                await fetchPRs(prPage);
                await fetchIssues(issuePage);
            } catch (error) {
                console.error("Error fetching contributor stats:", error);
            }
        };

        fetchContributorStats();
    }, [contributor.login]);

    const toggleAccordion = (section: string) => {
        setOpenAccordion((prev) => (prev === section ? null : section));
    };

    const fetchCommits = async (page: number) => {
        try {
            const commitResponse = await fetch(
                `https://api.github.com/repos/elizaos/eliza/commits?author=${contributor.login}&page=${page}`,
                {
                    method: "GET",
                    headers: {
                        Authorization: `token ${githubAccessToken}`,
                        Accept: "application/vnd.github.v3+json",
                    },
                },
            );
            const commitData = await commitResponse.json();
            const commitItems = commitData.map((commit: any) => ({
                html_url: commit.html_url,
                title: commit.commit.message,
                created_at: commit.commit.author.date,
            }));
            const currentCommitsData = [...commitsData.data, ...commitItems];
            setCommitsData({
                data: currentCommitsData,
                total_count: contributor.contributions,
            });
        } catch (error) {
            console.error("Error fetching commits:", error);
        }
    };

    const fetchPRs = async (page: number) => {
        try {
            const prResponse = await fetch(
                `https://api.github.com/search/issues?q=type:pr+author:${contributor.login}+repo:elizaos/eliza&page=${page}`,
                {
                    method: "GET",
                    headers: {
                        Authorization: `token ${githubAccessToken}`,
                        Accept: "application/vnd.github.v3+json",
                    },
                },
            );
            const prData = await prResponse.json();
            const prItems = prData.items.map((pr: any) => ({
                html_url: pr.html_url,
                title: pr.title,
                created_at: pr.created_at,
                bullet:
                    pr.state === "open"
                        ? BULLET_COLOR.OPEN
                        : pr.pull_request.merged_at
                          ? BULLET_COLOR.MERGE
                          : BULLET_COLOR.CLOSE,
            }));
            const currentPrsData = [...prsData.data, ...prItems];

            setPrsData({
                data: currentPrsData,
                total_count: prData.total_count,
            });
        } catch (error) {
            console.error("Error fetching PRs:", error);
        }
    };

    const fetchIssues = async (page: number) => {
        try {
            const issueResponse = await fetch(
                `https://api.github.com/search/issues?q=type:issue+author:${contributor.login}+repo:elizaos/eliza&page=${page}`,
                {
                    method: "GET",
                    headers: {
                        Authorization: `token ${githubAccessToken}`,
                        Accept: "application/vnd.github.v3+json",
                    },
                },
            );
            const issueData = await issueResponse.json();
            const issueItems = issueData.items.map((issue: any) => ({
                html_url: issue.html_url,
                title: issue.title,
                created_at: issue.created_at,
                bullet:
                    issue.state === "open"
                        ? BULLET_COLOR.OPEN
                        : BULLET_COLOR.CLOSE,
            }));
            const currentIssuesData = [...issuesData.data, ...issueItems];
            setIssuesData({
                data: currentIssuesData,
                total_count: issueData.total_count,
            });
        } catch (error) {
            console.error("Error fetching issues:", error);
        }
    };

    const accordionItems = [
        {
            title: "Commits",
            data: commitsData,
            section: "commits",
            loadMore: () => {
                const nextPage = commitPage + 1;
                fetchCommits(nextPage);
                setCommitPage(nextPage);
            },
        },
        {
            title: "Pull Requests",
            data: prsData,
            section: "pullRequests",
            loadMore: () => {
                const nextPage = prPage + 1;
                fetchPRs(nextPage);
                sePrPage(nextPage);
            },
        },
        {
            title: "Issues",
            data: issuesData,
            section: "issues",
            loadMore: () => {
                const nextPage = issuePage + 1;
                fetchIssues(nextPage);
                setIssuePage(nextPage);
            },
        },
    ];

    return (
        <div
            style={{
                display: "flex",
                flexDirection: "column",
                width: "100%",
                padding: "1rem",
                gap: "1rem",
                color: darkMode
                    ? THEME_COLORS.dark.primaryText
                    : THEME_COLORS.light.primaryText,
            }}
        >
            <div>
                <span
                    style={{ cursor: "pointer", fontWeight: "bold" }}
                    onClick={onBack}
                >
                    <span
                        style={{
                            border: "solid currentColor",
                            borderWidth: "0 2px 2px 0",
                            display: "inline-block",
                            height: "8px",
                            pointerEvents: "none",
                            transform: "translateY(-1px) rotate(135deg)",
                            width: "8px",
                            marginRight: "1px",
                        }}
                    ></span>
                    <span>back</span>
                </span>
            </div>
            <div
                style={{
                    height: "100px",
                    borderRadius: "0.5rem",
                    boxShadow: "0 4px 6px rgba(0, 0, 0, 0.1)",
                    backgroundColor: darkMode
                        ? THEME_COLORS.dark.mainBackgroundColor
                        : THEME_COLORS.light.mainBackgroundColor,
                    padding: "24px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                }}
            >
                <Hero
                    contributor={contributor}
                    secondaryText={
                        darkMode
                            ? THEME_COLORS.dark.secondaryText
                            : THEME_COLORS.light.secondaryText
                    }
                    profilePictureSize="64px"
                />
                <ScoreIcon
                    style={{
                        width: "6rem",
                        height: "2.5rem",
                        backgroundColor: darkMode
                            ? `rgba(${hexToRgb(THEME_COLORS.dark.secondaryText)}, 0.2)`
                            : `rgba(${hexToRgb(THEME_COLORS.light.secondaryText)}, 0.2)`,
                        color: darkMode
                            ? THEME_COLORS.dark.secondaryText
                            : THEME_COLORS.light.secondaryText,
                        fontSize: "1rem",
                        padding: "0.35",
                        fontWeight: "bold",
                        gap: "0.25rem",
                    }}
                    iconColor={
                        darkMode
                            ? THEME_COLORS.dark.secondaryText
                            : THEME_COLORS.light.secondaryText
                    }
                    iconSize="1.5rem"
                    score={score}
                />
            </div>

            <Summary
                summary={activitySummary}
                style={{
                    boxShadow: "0 4px 6px rgba(0, 0, 0, 0.1)",
                    borderRadius: "0.5rem",
                    padding: "2rem",
                    backgroundColor: darkMode
                        ? THEME_COLORS.dark.mainBackgroundColor
                        : THEME_COLORS.light.mainBackgroundColor,
                }}
            />

            <div
                style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                    gap: "1rem",
                }}
            >
                {accordionItems.map((stat, index) => (
                    <StatCard
                        key={index}
                        title={stat.title}
                        value={stat.data?.total_count}
                        style={{
                            backgroundColor: darkMode
                                ? THEME_COLORS.dark.mainBackgroundColor
                                : THEME_COLORS.light.mainBackgroundColor,
                            color: darkMode
                                ? THEME_COLORS.dark.primaryText
                                : THEME_COLORS.light.primaryText,
                        }}
                    />
                ))}
            </div>
            <div
                style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "1rem",
                }}
            >
                {accordionItems.map((item) => (
                    <Accordion
                        key={item.section}
                        title={item.title}
                        isOpen={openAccordion === item.section}
                        onToggle={() => toggleAccordion(item.section)}
                        data={item.data.data}
                        loadMore={item.loadMore}
                        total_count={item.data.total_count}
                        primaryText={
                            darkMode
                                ? THEME_COLORS.dark.primaryText
                                : THEME_COLORS.light.primaryText
                        }
                        secondaryText={
                            darkMode
                                ? THEME_COLORS.dark.secondaryText
                                : THEME_COLORS.light.secondaryText
                        }
                        mainBackgroundColor={
                            darkMode
                                ? THEME_COLORS.dark.mainBackgroundColor
                                : THEME_COLORS.light.mainBackgroundColor
                        }
                    />
                ))}
            </div>
        </div>
    );
};

export default Contributions;
