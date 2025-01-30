export const sleep = async (ms: number) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
};

export const base64ToHex = (base64: string) => {
    return Buffer.from(base64, "base64").toString("hex");
};
