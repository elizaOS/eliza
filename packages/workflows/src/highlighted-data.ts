import snakeCase from 'lodash/snakeCase.js';

export function getHighlightedInputKey(nodeName: string): string {
	return `input_${snakeCase(nodeName)}`;
}

export function getHighlightedResponseKey(nodeName: string): string {
	return `response_${snakeCase(nodeName)}`;
}

export const HIGHLIGHTED_SESSION_KEY = 'session_id';
