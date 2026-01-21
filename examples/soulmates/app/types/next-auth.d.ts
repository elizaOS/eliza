import "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name: string | null;
      email: string | null;
      phone: string;
      credits: number;
      status: "active" | "pending" | "blocked";
      isAdmin: boolean;
      allowlisted: boolean;
    };
  }
}
