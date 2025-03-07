import stringify from "json-stable-stringify";
import { requestApi, type RequestApiResult } from "./api";
import type { TwitterAuth } from "./auth";
import type { TwitterApiErrorRaw } from "./errors";

export interface LegacyUserRaw {
	created_at?: string;
	description?: string;
	entities?: {
		url?: {
			urls?: {
				expanded_url?: string;
			}[];
		};
	};
	favourites_count?: number;
	followers_count?: number;
	friends_count?: number;
	media_count?: number;
	statuses_count?: number;
	id_str?: string;
	listed_count?: number;
	name?: string;
	location: string;
	geo_enabled?: boolean;
	pinned_tweet_ids_str?: string[];
	profile_background_color?: string;
	profile_banner_url?: string;
	profile_image_url_https?: string;
	protected?: boolean;
	screen_name?: string;
	verified?: boolean;
	has_custom_timelines?: boolean;
	has_extended_profile?: boolean;
	url?: string;
	can_dm?: boolean;
}

/**
 * A parsed profile object.
 */
export interface Profile {
	avatar?: string;
	banner?: string;
	biography?: string;
	birthday?: string;
	followersCount?: number;
	followingCount?: number;
	friendsCount?: number;
	mediaCount?: number;
	statusesCount?: number;
	isPrivate?: boolean;
	isVerified?: boolean;
	isBlueVerified?: boolean;
	joined?: Date;
	likesCount?: number;
	listedCount?: number;
	location: string;
	name?: string;
	pinnedTweetIds?: string[];
	tweetsCount?: number;
	url?: string;
	userId?: string;
	username?: string;
	website?: string;
	canDm?: boolean;
}

export interface UserRaw {
	data: {
		user: {
			result: {
				rest_id?: string;
				is_blue_verified?: boolean;
				legacy: LegacyUserRaw;
			};
		};
	};
	errors?: TwitterApiErrorRaw[];
}

function getAvatarOriginalSizeUrl(avatarUrl: string | undefined) {
	return avatarUrl ? avatarUrl.replace("_normal", "") : undefined;
}

export function parseProfile(
	user: LegacyUserRaw,
	isBlueVerified?: boolean,
): Profile {
	const profile: Profile = {
		avatar: getAvatarOriginalSizeUrl(user.profile_image_url_https),
		banner: user.profile_banner_url,
		biography: user.description,
		followersCount: user.followers_count,
		followingCount: user.friends_count,
		friendsCount: user.friends_count,
		mediaCount: user.media_count,
		isPrivate: user.protected ?? false,
		isVerified: user.verified,
		likesCount: user.favourites_count,
		listedCount: user.listed_count,
		location: user.location,
		name: user.name,
		pinnedTweetIds: user.pinned_tweet_ids_str,
		tweetsCount: user.statuses_count,
		url: `https://twitter.com/${user.screen_name}`,
		userId: user.id_str,
		username: user.screen_name,
		isBlueVerified: isBlueVerified ?? false,
		canDm: user.can_dm,
	};

	if (user.created_at != null) {
		profile.joined = new Date(Date.parse(user.created_at));
	}

	const urls = user.entities?.url?.urls;
	if (urls?.length != null && urls?.length > 0) {
		profile.website = urls[0].expanded_url;
	}

	return profile;
}

export async function getProfile(
	username: string,
	auth: TwitterAuth,
): Promise<RequestApiResult<Profile>> {
	const params = new URLSearchParams();
	params.set(
		"variables",
		stringify({
			screen_name: username,
			withSafetyModeUserFields: true,
		}) ?? "",
	);

	params.set(
		"features",
		stringify({
			hidden_profile_likes_enabled: false,
			hidden_profile_subscriptions_enabled: false, // Auth-restricted
			responsive_web_graphql_exclude_directive_enabled: true,
			verified_phone_label_enabled: false,
			subscriptions_verification_info_is_identity_verified_enabled: false,
			subscriptions_verification_info_verified_since_enabled: true,
			highlights_tweets_tab_ui_enabled: true,
			creator_subscriptions_tweet_preview_api_enabled: true,
			responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
			responsive_web_graphql_timeline_navigation_enabled: true,
		}) ?? "",
	);

	params.set(
		"fieldToggles",
		stringify({ withAuxiliaryUserLabels: false }) ?? "",
	);

	const res = await requestApi<UserRaw>(
		`https://twitter.com/i/api/graphql/G3KGOASz96M-Qu0nwmGXNg/UserByScreenName?${params.toString()}`,
		auth,
	);
	if (!res.success) {
		return res as any;
	}

	const { value } = res;
	const { errors } = value;
	if (errors != null && errors.length > 0) {
		return {
			success: false,
			err: new Error(errors[0].message),
		};
	}

	if (!value.data || !value.data.user || !value.data.user.result) {
		return {
			success: false,
			err: new Error("User not found."),
		};
	}
	const { result: user } = value.data.user;
	const { legacy } = user;

	if (user.rest_id == null || user.rest_id.length === 0) {
		return {
			success: false,
			err: new Error("rest_id not found."),
		};
	}

	legacy.id_str = user.rest_id;

	if (legacy.screen_name == null || legacy.screen_name.length === 0) {
		return {
			success: false,
			err: new Error(`Either ${username} does not exist or is private.`),
		};
	}

	return {
		success: true,
		value: parseProfile(user.legacy, user.is_blue_verified),
	};
}

const idCache = new Map<string, string>();

export async function getScreenNameByUserId(
	userId: string,
	auth: TwitterAuth,
): Promise<RequestApiResult<string>> {
	const params = new URLSearchParams();
	params.set(
		"variables",
		stringify({
			userId: userId,
			withSafetyModeUserFields: true,
		}) ?? "",
	);

	params.set(
		"features",
		stringify({
			hidden_profile_subscriptions_enabled: true,
			rweb_tipjar_consumption_enabled: true,
			responsive_web_graphql_exclude_directive_enabled: true,
			verified_phone_label_enabled: false,
			highlights_tweets_tab_ui_enabled: true,
			responsive_web_twitter_article_notes_tab_enabled: true,
			subscriptions_feature_can_gift_premium: false,
			creator_subscriptions_tweet_preview_api_enabled: true,
			responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
			responsive_web_graphql_timeline_navigation_enabled: true,
		}) ?? "",
	);

	const res = await requestApi<UserRaw>(
		`https://twitter.com/i/api/graphql/xf3jd90KKBCUxdlI_tNHZw/UserByRestId?${params.toString()}`,
		auth,
	);

	if (!res.success) {
		return res as any;
	}

	const { value } = res;
	const { errors } = value;
	if (errors != null && errors.length > 0) {
		return {
			success: false,
			err: new Error(errors[0].message),
		};
	}

	if (!value.data || !value.data.user || !value.data.user.result) {
		return {
			success: false,
			err: new Error("User not found."),
		};
	}

	const { result: user } = value.data.user;
	const { legacy } = user;

	if (legacy.screen_name == null || legacy.screen_name.length === 0) {
		return {
			success: false,
			err: new Error(
				`Either user with ID ${userId} does not exist or is private.`,
			),
		};
	}

	return {
		success: true,
		value: legacy.screen_name,
	};
}

export async function getUserIdByScreenName(
	screenName: string,
	auth: TwitterAuth,
): Promise<RequestApiResult<string>> {
	const cached = idCache.get(screenName);
	if (cached != null) {
		return { success: true, value: cached };
	}

	const profileRes = await getProfile(screenName, auth);
	if (!profileRes.success) {
		return profileRes as any;
	}

	const profile = profileRes.value;
	if (profile.userId != null) {
		idCache.set(screenName, profile.userId);

		return {
			success: true,
			value: profile.userId,
		};
	}

	return {
		success: false,
		err: new Error("User ID is undefined."),
	};
}
