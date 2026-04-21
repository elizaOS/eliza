import { toast } from "react-toastify";

export async function toastOnError<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    toast.error(message);
    throw error;
  }
}
