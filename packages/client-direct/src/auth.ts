import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from "uuid";
import { settings } from "@elizaos/core";
import crypto from 'crypto';

export function md5(text: any) {
    return crypto.createHash('md5').update(text).digest('hex');
}

export const signToken = (data: Record<string, any>, expiresIn: string | number = settings.JWT_EXPIRED): string => {
    const _salt = uuidv4();
    return jwt.sign({ ...data, _salt }, settings.JWT_SECRET_KEY, {
        expiresIn: expiresIn
    });
};

export const verifyToken = (authorization: string): Promise<any> => {
    return new Promise((resolve, reject) => {
        jwt.verify(authorization, settings.JWT_SECRET_KEY, async (err: any, decode: any) => {
            if (err) {
                reject(err);
            } else {
                resolve(decode);
            }
        });
    });
};

