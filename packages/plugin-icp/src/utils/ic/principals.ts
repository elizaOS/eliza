import { Principal } from "@dfinity/principal";

// Check if string is a Principal
export const isPrincipalText = (text: string | undefined): boolean => {
    if (!text) return false;
    try {
        Principal.fromText(text);
        return true;
    } catch {
        return false;
    }
};

// Check if string is a Canister Id
export const isCanisterIdText = (text: string | undefined): boolean => {
    if (!text) return false;
    if (text.length !== 27) return false;
    return isPrincipalText(text);
};
