"use client";

import type { ProfileInfo } from "@feed/shared";
import {
  type Actor,
  cn,
  extractUsername,
  type FeedPost,
  getBannerImageUrl,
  isUsername,
  logger,
  type Organization,
  POST_TYPES,
} from "@feed/shared";
import { ArrowLeft, MessageCircle, Search } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { RecentAchievements } from "@/components/achievements";
import { ArticleCard } from "@/components/articles/ArticleCard";
import { FollowButton } from "@/components/interactions/FollowButton";
import { ModerationMenu } from "@/components/moderation/ModerationMenu";
import { PostCard } from "@/components/posts/PostCard";
import { FollowListModal } from "@/components/profile/FollowListModal";
import { OnChainBadge } from "@/components/profile/OnChainBadge";
import {
  type ProfileReply,
  ProfileReplyCard,
} from "@/components/profile/ProfileReplyCard";
import { Avatar } from "@/components/shared/Avatar";
import { EmptyState } from "@/components/shared/EmptyState";
import { PageContainer } from "@/components/shared/PageContainer";
import {
  FeedSkeleton,
  ProfileHeaderSkeleton,
} from "@/components/shared/Skeleton";
import { VerifiedBadge } from "@/components/shared/VerifiedBadge";
import { WidgetSidebar } from "@/components/shared/WidgetSidebar";
import { TradesFeed } from "@/components/trades/TradesFeed";
import { useAuth } from "@/hooks/useAuth";
import { useErrorToasts } from "@/hooks/useErrorToasts";
import { useGameStore } from "@/stores/gameStore";
import { apiUrl } from "@/utils/api-url";

type ProfileRouteMode = "auto" | "user" | "user_id" | "actor" | "org";

export function ProfilePageClient({
  identifier,
  mode,
}: {
  identifier: string;
  mode: ProfileRouteMode;
}) {
  const router = useRouter();
  const isUsernameParam = mode === "auto" ? isUsername(identifier) : false;

  const handleBack = useCallback(() => {
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
    } else {
      router.push("/feed");
    }
  }, [router]);

  // In "auto" mode the identifier might be either username or userId.
  // In other modes we treat identifier as the primary lookup key for that route.
  const routeKey =
    mode === "user"
      ? extractUsername(identifier)
      : mode === "auto" && isUsernameParam
        ? extractUsername(identifier)
        : identifier;

  const searchParams = useSearchParams();
  const { user, authenticated, getAccessToken } = useAuth();
  const [searchQuery, setSearchQuery] = useState("");
  const initialTab = searchParams.get("tab");
  const [tab, setTab] = useState<"posts" | "replies" | "trades">(
    initialTab === "trades" || initialTab === "replies" ? initialTab : "posts",
  );
  const { allGames } = useGameStore();
  const [optimisticFollowerCount, setOptimisticFollowerCount] = useState<
    number | null
  >(null);
  const [followListModal, setFollowListModal] = useState<{
    isOpen: boolean;
    type: "followers" | "following";
  }>({ isOpen: false, type: "followers" });

  // Only meaningful for user profiles.
  const isOwnProfile =
    authenticated &&
    user &&
    (user.id === routeKey ||
      user.id === identifier ||
      user.username === routeKey ||
      (user.username?.startsWith("@") && user.username.slice(1) === routeKey) ||
      (user.username &&
        !user.username.startsWith("@") &&
        user.username === routeKey));

  // Redirect /profile/<id> to username-based URL for own profile to avoid flash.
  // Only applies to auto mode (legacy /profile/[id]).
  useLayoutEffect(() => {
    if (mode !== "auto") return;

    if (authenticated && user?.username && !isUsernameParam) {
      const decodedIdentifier = decodeURIComponent(identifier);
      const viewingOwnId =
        user.id === routeKey ||
        user.id === decodedIdentifier ||
        user.id === identifier;

      if (viewingOwnId && user.username) {
        const cleanUsername = user.username.startsWith("@")
          ? user.username.slice(1)
          : user.username;
        if (
          cleanUsername &&
          identifier !== cleanUsername &&
          decodedIdentifier !== cleanUsername &&
          routeKey !== cleanUsername
        ) {
          router.replace(`/profile/${cleanUsername}`);
        }
      }
    }
  }, [
    mode,
    authenticated,
    user?.id,
    user?.username,
    routeKey,
    identifier,
    isUsernameParam,
    router,
  ]);

  useErrorToasts();

  const [actorInfo, setActorInfo] = useState<ProfileInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const hasFetchedRef = useRef(false);
  const isOwnProfileRef = useRef(isOwnProfile);
  isOwnProfileRef.current = isOwnProfile;
  const [isCreatingDM, setIsCreatingDM] = useState(false);
  const [apiPosts, setApiPosts] = useState<
    Array<{
      id: string;
      content: string;
      author: string;
      authorId: string;
      timestamp: string;
      authorName?: string;
      authorUsername?: string | null;
      authorProfileImageUrl?: string | null;
      likeCount?: number;
      commentCount?: number;
      shareCount?: number;
      isLiked?: boolean;
      isShared?: boolean;
      isRepost?: boolean;
      isQuote?: boolean;
      quoteComment?: string | null;
      originalPostId?: string | null;
      originalPost?: {
        id: string;
        content: string;
        authorId: string;
        authorName: string;
        authorUsername: string | null;
        authorProfileImageUrl: string | null;
        timestamp: string;
      } | null;
    }>
  >([]);
  const [loadingPosts, setLoadingPosts] = useState(false);
  const [replies, setReplies] = useState<ProfileReply[]>([]);
  const [loadingReplies, setLoadingReplies] = useState(false);

  const handleMessageClick = async () => {
    if (!authenticated || !actorInfo?.id || isCreatingDM || !user?.id) return;

    setIsCreatingDM(true);

    if (actorInfo.isAgent && actorInfo.managedBy === user.id) {
      router.push(
        `/agents/team?selectAgent=${encodeURIComponent(actorInfo.id)}`,
      );
      setIsCreatingDM(false);
      return;
    }

    const sortedIds = [user.id, actorInfo.id].sort();
    const chatId = `dm-${sortedIds.join("-")}`;
    router.push(`/chats?chat=${chatId}&newDM=${actorInfo.id}`);

    setIsCreatingDM(false);
  };

  const loadActorInfo = useCallback(async () => {
    // Only show full skeleton on the very first load, not on refreshes
    if (!hasFetchedRef.current) {
      setLoading(true);
    }

    const token = await getAccessToken();
    const headers: HeadersInit = { "Content-Type": "application/json" };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const actorIdLower = routeKey.toLowerCase();

    const allowUserLookup =
      mode === "auto" || mode === "user" || mode === "user_id";
    const allowActorLookup = mode === "auto" || mode === "actor";
    const allowOrgLookup = mode === "auto" || mode === "org";

    if (allowUserLookup) {
      if (mode === "user") {
        const usernameLookupResponse = await fetch(
          `/api/users/by-username/${encodeURIComponent(routeKey)}`,
          { headers },
        ).catch(() => null);

        if (usernameLookupResponse?.ok) {
          const usernameData = (await usernameLookupResponse.json()) as {
            user?: {
              id: string;
              displayName: string | null;
              username: string | null;
              bio: string | null;
              profileImageUrl: string | null;
              coverImageUrl: string | null;
              isActor: boolean;
              isAgent: boolean;
              managedBy: string | null;
              stats: unknown;
              nftTokenId?: number | null;
            } | null;
          };
          const foundUser = usernameData.user;
          if (foundUser && !foundUser.isActor) {
            setActorInfo({
              id: foundUser.id,
              name: foundUser.displayName || foundUser.username || "User",
              description: foundUser.bio || "",
              role: foundUser.isAgent ? "Agent" : "User",
              type: "user" as const,
              isUser: !foundUser.isAgent,
              isAgent: foundUser.isAgent || false,
              managedBy: foundUser.managedBy || null,
              username: foundUser.username ?? undefined,
              profileImageUrl: foundUser.profileImageUrl ?? undefined,
              coverImageUrl: foundUser.coverImageUrl ?? undefined,
              stats: foundUser.stats as ProfileInfo["stats"],
              nftTokenId: foundUser.nftTokenId ?? undefined,
            });
            setLoading(false);
            hasFetchedRef.current = true;
            return;
          }
        }

        setActorInfo(null);
        setLoading(false);
        hasFetchedRef.current = true;
        return;
      }

      // Auto + user_id: attempt by ID first
      const userResponse = await fetch(
        `/api/users/${encodeURIComponent(routeKey)}/profile`,
        { headers },
      ).catch(() => null);

      if (userResponse?.ok) {
        const userData = (await userResponse.json()) as {
          user?: {
            id: string;
            displayName: string | null;
            username: string | null;
            bio: string | null;
            profileImageUrl: string | null;
            coverImageUrl: string | null;
            walletAddress?: string | null;
            isActor: boolean;
            isAgent: boolean;
            managedBy: string | null;
            stats: unknown;
            nftTokenId?: number | null;
          } | null;
        };
        const foundUser = userData.user;

        const isNonActorUser =
          foundUser &&
          !foundUser.isActor &&
          (foundUser.displayName ||
            foundUser.username ||
            foundUser.profileImageUrl ||
            foundUser.walletAddress);

        if (isNonActorUser) {
          setActorInfo({
            id: foundUser.id,
            name: foundUser.displayName || foundUser.username || "User",
            description: foundUser.bio || "",
            role: foundUser.isAgent ? "Agent" : "User",
            type: "user" as const,
            isUser: !foundUser.isAgent,
            isAgent: foundUser.isAgent || false,
            managedBy: foundUser.managedBy || null,
            username: foundUser.username ?? undefined,
            profileImageUrl: foundUser.profileImageUrl ?? undefined,
            coverImageUrl: foundUser.coverImageUrl ?? undefined,
            stats: foundUser.stats as ProfileInfo["stats"],
            nftTokenId: foundUser.nftTokenId ?? undefined,
          });

          // In legacy /profile, redirect to username URL for non-own profiles.
          if (
            mode === "auto" &&
            foundUser.username &&
            !isUsernameParam &&
            !isOwnProfileRef.current
          ) {
            const cleanUsername = foundUser.username.startsWith("@")
              ? foundUser.username.slice(1)
              : foundUser.username;
            if (cleanUsername.toLowerCase() !== routeKey.toLowerCase()) {
              router.replace(`/profile/${cleanUsername}`);
              return;
            }
          }

          setLoading(false);
          hasFetchedRef.current = true;
          return;
        }
      }

      // Auto: fallback to username lookup.
      if (mode === "auto") {
        const allowUsernameLookup =
          isUsernameParam ||
          (!routeKey.startsWith("steward:test:") &&
            routeKey.length <= 42 &&
            !routeKey.includes("-"));

        if (allowUsernameLookup) {
          const usernameLookupResponse = await fetch(
            `/api/users/by-username/${encodeURIComponent(routeKey)}`,
            { headers },
          ).catch(() => null);

          if (usernameLookupResponse?.ok) {
            const usernameData = (await usernameLookupResponse.json()) as {
              user?: {
                id: string;
                displayName: string | null;
                username: string | null;
                bio: string | null;
                profileImageUrl: string | null;
                coverImageUrl: string | null;
                isActor: boolean;
                isAgent: boolean;
                managedBy: string | null;
                stats: unknown;
                nftTokenId?: number | null;
              } | null;
            };

            const foundUser = usernameData.user;
            if (foundUser && !foundUser.isActor) {
              setActorInfo({
                id: foundUser.id,
                name: foundUser.displayName || foundUser.username || "User",
                description: foundUser.bio || "",
                role: foundUser.isAgent ? "Agent" : "User",
                type: "user" as const,
                isUser: !foundUser.isAgent,
                isAgent: foundUser.isAgent || false,
                managedBy: foundUser.managedBy || null,
                username: foundUser.username ?? undefined,
                profileImageUrl: foundUser.profileImageUrl ?? undefined,
                coverImageUrl: foundUser.coverImageUrl ?? undefined,
                stats: foundUser.stats as ProfileInfo["stats"],
                nftTokenId: foundUser.nftTokenId ?? undefined,
              });

              if (
                !isUsernameParam &&
                foundUser.username &&
                !isOwnProfileRef.current
              ) {
                const cleanUsername = foundUser.username.startsWith("@")
                  ? foundUser.username.slice(1)
                  : foundUser.username;
                if (cleanUsername.toLowerCase() !== routeKey.toLowerCase()) {
                  router.replace(`/profile/${cleanUsername}`);
                  return;
                }
              }

              setLoading(false);
              hasFetchedRef.current = true;
              return;
            }
          }
        }
      }

      if (mode === "user_id") {
        setActorInfo(null);
        setLoading(false);
        hasFetchedRef.current = true;
        return;
      }
    }

    // Actor/org lookup
    if (!allowActorLookup && !allowOrgLookup) {
      setActorInfo(null);
      setLoading(false);
      hasFetchedRef.current = true;
      return;
    }

    let actorsDb: { actors?: Actor[]; organizations?: Organization[] } = {
      actors: [],
      organizations: [],
    };
    try {
      const response = await fetch(apiUrl("/api/actors"));
      if (response.ok) {
        actorsDb = (await response.json()) as typeof actorsDb;
      }
    } catch {
      // Fail closed below.
    }

    if (allowActorLookup) {
      let actor = actorsDb.actors?.find((a) => a.id === routeKey);
      if (!actor) {
        actor = actorsDb.actors?.find(
          (a) =>
            "username" in a &&
            typeof a.username === "string" &&
            a.username.toLowerCase() === actorIdLower,
        );
      }
      if (!actor) {
        actor = actorsDb.actors?.find(
          (a) => a.name.toLowerCase() === actorIdLower,
        );
      }

      if (actor) {
        let gameId: string | null = null;
        for (const game of allGames) {
          const allActors = [
            ...(game.setup?.mainActors || []),
            ...(game.setup?.supportingActors || []),
            ...(game.setup?.extras || []),
          ];
          if (allActors.some((a) => a.id === actor.id)) {
            gameId = game.id;
            break;
          }
        }

        let stats = { followers: 0, following: 0, posts: 0 };
        const statsResponse = await fetch(
          `/api/actors/${encodeURIComponent(actor.id)}/stats`,
        ).catch(() => null);

        if (statsResponse?.ok) {
          const statsData = (await statsResponse.json()) as {
            stats?: { followers?: number; following?: number; posts?: number };
          };
          if (statsData.stats) {
            stats = {
              followers: statsData.stats.followers || 0,
              following: statsData.stats.following || 0,
              posts: statsData.stats.posts || 0,
            };
          }
        }

        setActorInfo({
          id: actor.id,
          name: actor.name,
          description: actor.description,
          profileDescription: actor.profileDescription,
          tier: actor.tier,
          domain: actor.domain,
          personality: actor.personality,
          affiliations: actor.affiliations,
          role: actor.role || actor.tier || "Actor",
          type: "actor" as const,
          game: gameId ? { id: gameId } : undefined,
          username: ("username" in actor
            ? (actor.username as string)
            : actor.id) as string | undefined,
          profileImageUrl:
            "profileImageUrl" in actor &&
            typeof actor.profileImageUrl === "string" &&
            actor.profileImageUrl
              ? actor.profileImageUrl
              : `/images/actors/${actor.id}.jpg`,
          stats,
        });
        setLoading(false);
        hasFetchedRef.current = true;
        return;
      }
    }

    if (allowOrgLookup) {
      let org = actorsDb.organizations?.find((o) => o.id === routeKey);
      if (!org) {
        org = actorsDb.organizations?.find(
          (o) => o.name.toLowerCase() === actorIdLower,
        );
      }
      if (org) {
        let stats = { followers: 0, following: 0, posts: 0 };
        const statsResponse = await fetch(
          `/api/actors/${encodeURIComponent(org.id)}/stats`,
        ).catch(() => null);

        if (statsResponse?.ok) {
          const statsData = (await statsResponse.json()) as {
            stats?: { followers?: number; following?: number; posts?: number };
          };
          if (statsData.stats) {
            stats = {
              followers: statsData.stats.followers || 0,
              following: statsData.stats.following || 0,
              posts: statsData.stats.posts || 0,
            };
          }
        }

        const orgProfileImageUrl =
          "profileImageUrl" in org &&
          typeof org.profileImageUrl === "string" &&
          org.profileImageUrl
            ? org.profileImageUrl
            : `/images/organizations/${org.id}.jpg`;

        setActorInfo({
          id: org.id,
          name: org.name,
          description: org.description,
          profileDescription: org.profileDescription,
          type: "organization" as const,
          role: "Organization",
          profileImageUrl: orgProfileImageUrl,
          stats,
        });
        setLoading(false);
        hasFetchedRef.current = true;
        return;
      }
    }

    setActorInfo(null);
    setLoading(false);
    hasFetchedRef.current = true;
  }, [allGames, getAccessToken, isUsernameParam, mode, routeKey, router]);

  useEffect(() => {
    void loadActorInfo();
  }, [loadActorInfo]);

  useEffect(() => {
    const handleProfileUpdate = () => {
      setTimeout(() => {
        setOptimisticFollowerCount(null);
        void loadActorInfo();
      }, 1000);
    };

    window.addEventListener("profile-updated", handleProfileUpdate);
    return () =>
      window.removeEventListener("profile-updated", handleProfileUpdate);
  }, [loadActorInfo]);

  useEffect(() => {
    if (actorInfo && optimisticFollowerCount !== null) {
      const timer = setTimeout(() => {
        setOptimisticFollowerCount(null);
      }, 2000);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [actorInfo, optimisticFollowerCount]);

  useEffect(() => {
    const loadPosts = async () => {
      if (!routeKey) return;

      setLoadingPosts(true);
      const searchId = actorInfo?.id || routeKey;
      const response = await fetch(
        `/api/posts?actorId=${encodeURIComponent(searchId)}&limit=100`,
      );
      if (response.ok) {
        const data = (await response.json()) as { posts?: unknown };
        if (data.posts && Array.isArray(data.posts)) {
          setApiPosts(data.posts as typeof apiPosts);
        }
      }
      setLoadingPosts(false);
    };

    if (actorInfo?.id) {
      void loadPosts();
    }
  }, [routeKey, actorInfo?.id]);

  useEffect(() => {
    if (tab !== "replies") return;
    if (!actorInfo?.id) return;

    const controller = new AbortController();

    const loadReplies = async () => {
      setLoadingReplies(true);
      try {
        const token = await getAccessToken();
        const headers: HeadersInit = { "Content-Type": "application/json" };
        if (token) {
          headers.Authorization = `Bearer ${token}`;
        }

        const response = await fetch(
          `/api/users/${encodeURIComponent(actorInfo.id)}/posts?type=replies`,
          { headers, signal: controller.signal },
        );
        if (response.ok) {
          const data = (await response.json()) as {
            data?: { items?: ProfileReply[] };
            items?: ProfileReply[];
          };
          const items = data?.data?.items ?? data?.items ?? [];
          setReplies(items);
        }
      } catch (error) {
        if (error instanceof Error && error.name !== "AbortError") {
          logger.error(
            "Failed to fetch replies",
            error instanceof Error ? error : { error },
            "ProfilePageClient",
          );
        }
      } finally {
        setLoadingReplies(false);
      }
    };

    void loadReplies();

    return () => controller.abort();
  }, [tab, actorInfo?.id, getAccessToken]);

  const gameStorePosts = useMemo(() => {
    const posts: Array<{
      post: FeedPost;
      gameId: string;
      gameName: string;
      timestampMs: number;
    }> = [];

    allGames.forEach((game) => {
      game.timeline?.forEach((day) => {
        day.feedPosts?.forEach((post) => {
          if (post.author === routeKey) {
            const postDate = new Date(post.timestamp);
            posts.push({
              post,
              gameId: game.id,
              gameName: game.id,
              timestampMs: postDate.getTime(),
            });
          }
        });
      });
    });

    return posts.sort((a, b) => b.timestampMs - a.timestampMs);
  }, [allGames, routeKey]);

  const actorPosts = useMemo(() => {
    const combined: Array<{
      post: FeedPost;
      gameId: string;
      gameName: string;
      timestampMs: number;
    }> = [];

    apiPosts.forEach((apiPost) => {
      combined.push({
        post: {
          id: apiPost.id,
          day: 0,
          content: apiPost.content,
          author: apiPost.authorId,
          authorName: apiPost.authorName || actorInfo?.name || apiPost.authorId,
          authorUsername: apiPost.authorUsername || actorInfo?.username || null,
          authorProfileImageUrl:
            apiPost.authorProfileImageUrl || actorInfo?.profileImageUrl || null,
          timestamp: apiPost.timestamp,
          type: POST_TYPES.POST,
          sentiment: 0,
          clueStrength: 0,
          pointsToward: null,
          likeCount: apiPost.likeCount,
          commentCount: apiPost.commentCount,
          shareCount: apiPost.shareCount,
          isLiked: apiPost.isLiked,
          isShared: apiPost.isShared,
          isRepost: apiPost.isRepost,
          isQuote: apiPost.isQuote,
          quoteComment: apiPost.quoteComment,
          originalPostId: apiPost.originalPostId,
          originalPost: apiPost.originalPost,
        },
        gameId: "",
        gameName: "",
        timestampMs: new Date(apiPost.timestamp).getTime(),
      });
    });

    const apiPostIds = new Set(apiPosts.map((p) => p.id));
    gameStorePosts.forEach((gamePost) => {
      if (!apiPostIds.has(gamePost.post.id)) {
        combined.push({
          ...gamePost,
          post: {
            ...gamePost.post,
            authorProfileImageUrl:
              gamePost.post.authorProfileImageUrl ||
              actorInfo?.profileImageUrl ||
              null,
          },
        });
      }
    });

    return combined.sort((a, b) => b.timestampMs - a.timestampMs);
  }, [apiPosts, gameStorePosts, actorInfo]);

  const originalPosts = useMemo(() => {
    return actorPosts.filter((item) => !item.post.replyTo);
  }, [actorPosts]);

  const replyPosts = useMemo(() => {
    return actorPosts.filter((item) => item.post.replyTo);
  }, [actorPosts]);

  const tabFilteredPosts = useMemo(() => {
    return tab === "posts" ? originalPosts : replyPosts;
  }, [tab, originalPosts, replyPosts]);

  const filteredPosts = useMemo(() => {
    if (!searchQuery.trim()) return tabFilteredPosts;

    const query = searchQuery.toLowerCase();
    return tabFilteredPosts.filter((item) =>
      item.post.content?.toLowerCase().includes(query),
    );
  }, [tabFilteredPosts, searchQuery]);

  if (loading) {
    if (isOwnProfile && user?.username && mode === "auto" && !isUsernameParam) {
      return null;
    }

    return (
      <PageContainer noPadding className="min-h-dvh md:min-h-screen">
        <div className="flex flex-1 overflow-hidden">
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <div className="flex-1 overflow-y-auto">
              <ProfileHeaderSkeleton />
              <div className="mt-4 border-border/5 border-t">
                <FeedSkeleton count={5} />
              </div>
            </div>
          </div>

          <WidgetSidebar />
        </div>
      </PageContainer>
    );
  }

  if (!actorInfo) {
    return (
      <PageContainer noPadding className="flex flex-col">
        <div className="sticky top-0 z-10 bg-background">
          <div className="flex items-center gap-4 px-4 py-3">
            <button
              type="button"
              onClick={handleBack}
              className="rounded-full p-2 transition-colors hover:bg-muted/50"
              aria-label="Go back"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
            <h1 className="font-bold text-xl">Profile Not Found</h1>
          </div>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <p className="text-muted-foreground">
            Profile &quot;{routeKey}&quot; not found
          </p>
          <button
            type="button"
            onClick={handleBack}
            className="rounded-lg bg-primary px-6 py-3 font-semibold text-primary-foreground transition-all hover:bg-primary/90"
          >
            Back to Feed
          </button>
        </div>
      </PageContainer>
    );
  }

  const postsCount = actorInfo.stats?.posts || actorPosts.length;

  return (
    <PageContainer noPadding className="flex flex-col">
      <div className="flex flex-1 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm">
            <div className="flex items-center gap-4 px-4 py-3">
              <button
                type="button"
                onClick={handleBack}
                className="rounded-full p-2 transition-colors hover:bg-muted/50"
                aria-label="Go back"
              >
                <ArrowLeft className="h-5 w-5" />
              </button>
              <div className="flex-1">
                <h1 className="font-bold text-xl">{actorInfo.name}</h1>
                <p className="text-muted-foreground text-sm">
                  {postsCount} posts
                </p>
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            <div className="border-border border-b">
              <div className="relative h-[200px] bg-muted">
                {(() => {
                  const bannerUrl =
                    (actorInfo.isUser || actorInfo.isAgent) &&
                    actorInfo.type === "user" &&
                    "coverImageUrl" in actorInfo
                      ? (actorInfo.coverImageUrl as string)
                      : getBannerImageUrl(
                          null,
                          actorInfo.id,
                          actorInfo.type === "organization"
                            ? "organization"
                            : "actor",
                        );

                  return bannerUrl ? (
                    <img
                      src={bannerUrl}
                      alt={`${actorInfo.name} banner`}
                      className="h-full w-full object-cover"
                      onError={(e) => {
                        e.currentTarget.style.display = "none";
                        e.currentTarget.nextElementSibling?.classList.remove(
                          "hidden",
                        );
                      }}
                    />
                  ) : null;
                })()}
                <div
                  className={cn(
                    "pointer-events-none absolute inset-0 h-full w-full bg-gradient-to-br from-primary/20 to-primary/5",
                    actorInfo.type === "actor" ||
                      actorInfo.type === "organization"
                      ? "hidden"
                      : "",
                  )}
                />
              </div>

              <div className="px-4 pb-4">
                <div className="mb-4 flex items-start justify-between">
                  <div className="relative -mt-16 sm:-mt-20">
                    <div className="h-32 w-32 overflow-hidden rounded-full border-4 border-background bg-background sm:h-36 sm:w-36">
                      <Avatar
                        id={actorInfo.id}
                        name={
                          (actorInfo.name ?? actorInfo.username ?? "") as string
                        }
                        type={
                          actorInfo.type === "organization"
                            ? "business"
                            : actorInfo.isUser || actorInfo.type === "user"
                              ? "user"
                              : (actorInfo.type as "actor" | undefined)
                        }
                        src={actorInfo.profileImageUrl || undefined}
                        size="lg"
                        className="h-full w-full"
                      />
                    </div>
                  </div>

                  <div className="flex items-center gap-2 pt-3">
                    {authenticated && user && user.id !== actorInfo.id && (
                      <>
                        {((actorInfo.isUser && actorInfo.type === "user") ||
                          actorInfo.isAgent) && (
                          <button
                            onClick={() => void handleMessageClick()}
                            disabled={isCreatingDM}
                            className="rounded-full border border-border p-2 transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50"
                            title={
                              actorInfo.isAgent &&
                              actorInfo.managedBy === user.id
                                ? "Message in Agents"
                                : "Send message"
                            }
                          >
                            <MessageCircle className="h-5 w-5" />
                          </button>
                        )}
                        <FollowButton
                          userId={actorInfo.id}
                          size="md"
                          variant="button"
                          onFollowerCountChange={(delta) => {
                            setOptimisticFollowerCount((prev) => {
                              const currentCount =
                                prev !== null
                                  ? prev
                                  : actorInfo.stats?.followers || 0;
                              return Math.max(0, currentCount + delta);
                            });
                          }}
                        />
                        {actorInfo.isUser && actorInfo.type === "user" && (
                          <ModerationMenu
                            targetUserId={actorInfo.id}
                            targetUsername={actorInfo.username ?? undefined}
                            targetDisplayName={actorInfo.name ?? undefined}
                            targetProfileImageUrl={
                              actorInfo.profileImageUrl ?? undefined
                            }
                            onActionComplete={() => {
                              void loadActorInfo();
                            }}
                          />
                        )}
                      </>
                    )}
                    {isOwnProfile && actorInfo.type === "user" && (
                      <Link
                        href="/settings?tab=profile"
                        className="rounded-full border border-border px-4 py-2 font-bold transition-colors hover:bg-muted/50"
                      >
                        Edit profile
                      </Link>
                    )}
                  </div>
                </div>

                <div className="mb-3">
                  <div className="mb-0.5 flex items-center gap-1">
                    <h2 className="font-bold text-xl">
                      {actorInfo.name ?? actorInfo.username ?? ""}
                    </h2>
                    {actorInfo.type === "actor" && !actorInfo.isUser && (
                      <VerifiedBadge size="md" />
                    )}
                    {actorInfo.type === "user" && (
                      <OnChainBadge
                        isRegistered={Boolean(actorInfo.nftTokenId)}
                        nftTokenId={actorInfo.nftTokenId ?? null}
                        size="md"
                      />
                    )}
                  </div>
                  {actorInfo.username && (
                    <p className="text-[15px] text-muted-foreground">
                      @{actorInfo.username}
                    </p>
                  )}
                </div>

                {actorInfo.description && (
                  <p className="mb-3 whitespace-pre-wrap text-[15px] text-foreground">
                    {actorInfo.description}
                  </p>
                )}

                {actorInfo.type === "user" && (
                  <div className="mb-3">
                    <RecentAchievements userId={actorInfo.id} />
                  </div>
                )}

                <div className="flex gap-4 text-[15px]">
                  <button
                    onClick={() =>
                      setFollowListModal({ isOpen: true, type: "following" })
                    }
                    className="hover:underline"
                  >
                    <span className="font-bold text-foreground">
                      {actorInfo.stats?.following || 0}
                    </span>
                    <span className="ml-1 text-muted-foreground">
                      Following
                    </span>
                  </button>
                  <button
                    onClick={() =>
                      setFollowListModal({ isOpen: true, type: "followers" })
                    }
                    className="hover:underline"
                  >
                    <span className="font-bold text-foreground">
                      {optimisticFollowerCount !== null
                        ? optimisticFollowerCount
                        : actorInfo.stats?.followers || 0}
                    </span>
                    <span className="ml-1 text-muted-foreground">
                      Followers
                    </span>
                  </button>
                </div>
              </div>
            </div>

            <div className="border-border/5 border-t">
              <div className="sticky top-[57px] z-10 border-border/5 border-b bg-background/95 backdrop-blur-sm">
                <div className="flex items-center gap-3 px-4 py-2">
                  <div className="flex flex-1 gap-2">
                    <button
                      onClick={() => setTab("posts")}
                      className={cn(
                        "flex flex-1 items-center justify-center gap-1.5 rounded-full px-3 py-2 font-medium text-sm transition-colors",
                        tab === "posts"
                          ? "bg-muted text-foreground"
                          : "text-muted-foreground hover:bg-muted/50",
                      )}
                    >
                      Posts
                    </button>
                    <button
                      onClick={() => setTab("replies")}
                      className={cn(
                        "flex flex-1 items-center justify-center gap-1.5 rounded-full px-3 py-2 font-medium text-sm transition-colors",
                        tab === "replies"
                          ? "bg-muted text-foreground"
                          : "text-muted-foreground hover:bg-muted/50",
                      )}
                    >
                      Replies
                    </button>
                    <button
                      onClick={() => setTab("trades")}
                      className={cn(
                        "flex flex-1 items-center justify-center gap-1.5 rounded-full px-3 py-2 font-medium text-sm transition-colors",
                        tab === "trades"
                          ? "bg-muted text-foreground"
                          : "text-muted-foreground hover:bg-muted/50",
                      )}
                    >
                      Trades
                    </button>
                  </div>
                </div>

                <div className="px-4 pb-2">
                  <div className="flex items-center gap-2 rounded-full border border-border bg-background px-3 py-2">
                    <Search className="h-4 w-4 text-muted-foreground" />
                    <input
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search posts..."
                      className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                    />
                  </div>
                </div>
              </div>

              <div className="sm:px-4 sm:py-4">
                {tab === "trades" ? (
                  <TradesFeed userId={actorInfo.id} />
                ) : tab === "replies" ? (
                  loadingReplies ? (
                    <FeedSkeleton count={5} />
                  ) : replies.length === 0 ? (
                    <EmptyState
                      title="No replies yet"
                      description="This user hasn't replied to any posts yet."
                    />
                  ) : (
                    <div>
                      {replies.map((reply) => (
                        <ProfileReplyCard
                          key={reply.id}
                          reply={reply}
                          authorId={actorInfo.id}
                          authorName={actorInfo.name ?? ""}
                          authorUsername={actorInfo.username ?? null}
                          authorProfileImageUrl={
                            actorInfo.profileImageUrl ?? null
                          }
                        />
                      ))}
                    </div>
                  )
                ) : loadingPosts ? (
                  <FeedSkeleton count={5} />
                ) : filteredPosts.length === 0 ? (
                  <EmptyState
                    title="No posts found"
                    description={
                      searchQuery.trim()
                        ? "Try a different search query."
                        : "This user hasn't posted yet."
                    }
                  />
                ) : (
                  <div>
                    {filteredPosts.map((item, i) => {
                      const postData = {
                        id: item.post.id,
                        type: item.post.type,
                        content: item.post.content,
                        timestamp: item.post.timestamp,
                        likeCount: item.post.likeCount,
                        commentCount: item.post.commentCount,
                        shareCount: item.post.shareCount,
                        authorId: item.post.author,
                        authorName: item.post.authorName ?? "",
                        author: {
                          id: item.post.author,
                          displayName: item.post.authorName,
                          username: item.post.authorUsername,
                          profileImageUrl: item.post.authorProfileImageUrl,
                        },
                        authorProfileImageUrl: item.post.authorProfileImageUrl,
                        isLiked: item.post.isLiked,
                        isShared: item.post.isShared,
                        isRepost: item.post.isRepost || false,
                        isQuote: item.post.isQuote || false,
                        quoteComment: item.post.quoteComment || null,
                        originalPostId: item.post.originalPostId || null,
                        originalPost: item.post.originalPost || null,
                      };

                      return postData.type && postData.type === "article" ? (
                        <ArticleCard
                          key={`${item.post.id}-${i}`}
                          post={postData}
                        />
                      ) : (
                        <PostCard
                          key={`${item.post.id}-${i}`}
                          post={postData}
                          showInteractions={true}
                          showCommentInputBar={false}
                          onCommentClick={() =>
                            router.push(`/post/${item.post.id}`)
                          }
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        <WidgetSidebar />
      </div>
      {actorInfo && (
        <FollowListModal
          isOpen={followListModal.isOpen}
          onClose={() =>
            setFollowListModal({ ...followListModal, isOpen: false })
          }
          userId={actorInfo.id}
          type={followListModal.type}
        />
      )}
    </PageContainer>
  );
}
