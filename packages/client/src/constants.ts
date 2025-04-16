export const USER_NAME = 'user';
export const CHAT_SOURCE = 'client_chat';
export const GROUP_CHAT_SOURCE = 'client_group_chat';

export const AVATAR_IMAGE_MAX_SIZE = 300;

export enum FIELD_REQUIREMENT {
  REQUIRED = 'required',
  OPTIONAL = 'optional',
}

export const FIELD_REQUIREMENTS = {
  name: FIELD_REQUIREMENT.REQUIRED,
  username: FIELD_REQUIREMENT.REQUIRED,
  system: FIELD_REQUIREMENT.REQUIRED,
  'settings.voice.model': FIELD_REQUIREMENT.OPTIONAL,
  bio: FIELD_REQUIREMENT.OPTIONAL,
  topics: FIELD_REQUIREMENT.OPTIONAL,
  adjectives: FIELD_REQUIREMENT.OPTIONAL,
  'style.all': FIELD_REQUIREMENT.OPTIONAL,
  'style.chat': FIELD_REQUIREMENT.OPTIONAL,
  'style.post': FIELD_REQUIREMENT.OPTIONAL,
};
