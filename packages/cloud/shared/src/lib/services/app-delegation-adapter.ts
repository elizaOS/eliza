/** Binds app delegation to canonical app consent codes and the primary registration/grant repository. */
import { appDelegationsRepository } from "../../db/repositories/app-delegations";
import { consumeAppAuthCode } from "./app-auth-codes";
import { AppDelegationService } from "./app-delegation";

export const appDelegationService = new AppDelegationService(
  appDelegationsRepository,
  consumeAppAuthCode,
);
