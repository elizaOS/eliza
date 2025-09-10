// Authentication actions
export { findUserIdByEmail } from './findUserIdByEmail';
export { findUserIdByNameZip } from './findUserIdByNameZip';
export { getUserDetails } from './getUserDetails';

// Order management actions
export { getOrderDetails } from './getOrderDetails';
export { cancelPendingOrder } from './cancelPendingOrder';
export { modifyPendingOrderAddress } from './modifyPendingOrderAddress';
export { modifyPendingOrderItems } from './modifyPendingOrderItems';
export { modifyPendingOrderPayment } from './modifyPendingOrderPayment';

// Product actions
export { getProductDetails } from './getProductDetails';
export { listAllProductTypes } from './listAllProductTypes';

// Return/Exchange actions
export { returnDeliveredOrderItems } from './returnDeliveredOrderItems';
export { exchangeDeliveredOrderItems } from './exchangeDeliveredOrderItems';

// User actions
export { modifyUserAddress } from './modifyUserAddress';

// Support actions
export { calculate } from './calculate';
// export { think } from './think';
export { transferToHumanAgents } from './transferToHumanAgents';

// Export all actions as an array
import type { Action } from '@elizaos/core';

// Import actions for the array
import { findUserIdByEmail as findUserIdByEmailAction } from './findUserIdByEmail';
import { findUserIdByNameZip as findUserIdByNameZipAction } from './findUserIdByNameZip';
import { getUserDetails as getUserDetailsAction } from './getUserDetails';
import { getOrderDetails as getOrderDetailsAction } from './getOrderDetails';
import { cancelPendingOrder as cancelPendingOrderAction } from './cancelPendingOrder';
import { modifyPendingOrderAddress as modifyPendingOrderAddressAction } from './modifyPendingOrderAddress';
import { modifyPendingOrderItems as modifyPendingOrderItemsAction } from './modifyPendingOrderItems';
import { modifyPendingOrderPayment as modifyPendingOrderPaymentAction } from './modifyPendingOrderPayment';
import { getProductDetails as getProductDetailsAction } from './getProductDetails';
import { listAllProductTypes as listAllProductTypesAction } from './listAllProductTypes';
import { returnDeliveredOrderItems as returnDeliveredOrderItemsAction } from './returnDeliveredOrderItems';
import { exchangeDeliveredOrderItems as exchangeDeliveredOrderItemsAction } from './exchangeDeliveredOrderItems';
import { modifyUserAddress as modifyUserAddressAction } from './modifyUserAddress';
import { calculate as calculateAction } from './calculate';
import { think as thinkAction } from './think';
import { transferToHumanAgents as transferToHumanAgentsAction } from './transferToHumanAgents';

export const retailActions: Action[] = [
  // Authentication actions
  findUserIdByEmailAction,
  findUserIdByNameZipAction,
  getUserDetailsAction,

  // Order management actions
  getOrderDetailsAction,
  cancelPendingOrderAction,
  modifyPendingOrderAddressAction,
  modifyPendingOrderItemsAction,
  modifyPendingOrderPaymentAction,

  // Product actions
  getProductDetailsAction,
  listAllProductTypesAction,

  // Return/Exchange actions
  returnDeliveredOrderItemsAction,
  exchangeDeliveredOrderItemsAction,

  // User actions
  modifyUserAddressAction,

  // Support actions
  calculateAction,
  // thinkAction,
  transferToHumanAgentsAction,

  // // Think
  // thinkAction,
];
