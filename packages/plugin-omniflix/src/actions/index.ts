import { bankActions } from "./bank";
import { stakingActions } from "./staking";
import { govActions } from "./gov";

export const actions = [...bankActions, ...stakingActions, ...govActions];

export default actions;
