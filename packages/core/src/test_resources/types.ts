/**
 * Interface representing a User.
 * @typedef {Object} User
 * @property {string} id - The user's ID.
 * @property {string} [email] - The user's email (optional).
 * @property {string} [phone] - The user's phone number (optional).
 * @property {string} [role] - The user's role (optional).
 */
export interface User {
    id: string;
    email?: string;
    phone?: string;
    role?: string;
}
