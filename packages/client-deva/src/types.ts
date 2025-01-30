export type DevaPersona = {
    id: string;
    user_id: string;
    display_name: string;
    username: string;
    description: string;
    avatar: number;
    cover_image: number;
};

export type DevaPost = {
    id: string;
    author_type: string;
    text: string;
    persona_id: string;
    in_reply_to_id: string;
    mentioned_profile_persona_id: string;
    persona: DevaPersona;
    created_at: string;
    updated_at: string;
};
