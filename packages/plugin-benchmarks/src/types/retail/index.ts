export interface UserProfile {
  name: {
    first_name: string;
    last_name: string;
  };
  address: Address;
  email: string;
  payment_methods: {
    [payment_id: string]: PaymentMethod;
  };
  addresses?: {
    [address_id: string]: Address;
  };
}

export interface Address {
  address1: string;
  address2?: string;
  city: string;
  country: string;
  state: string;
  zip: string;
}

export type PaymentMethod = CreditCardPayment | PayPalPayment | GiftCardPayment;

export interface CreditCardPayment {
  source: 'credit_card';
  brand: string;
  last_four: string;
  id: string;
}

export interface PayPalPayment {
  source: 'paypal';
  id: string;
}

export interface GiftCardPayment {
  source: 'gift_card';
  id: string;
  balance?: number; // Must match Python implementation
}

export interface Order {
  order_id: string;
  user_id: string;
  address: Address;
  items: OrderItem[];
  fulfillments?: Array<{
    tracking_id: string[];
    item_ids: string[];
  }>;
  status:
    | 'pending'
    | 'processed'
    | 'delivered'
    | 'returned'
    | 'exchanged'
    | 'cancelled'
    | 'exchange requested';
  payment_history?: Array<{
    transaction_type: string;
    amount: number;
    payment_method_id: string;
  }>;
  payment_method_id?: string;
  created_at?: string; // ISO date string
  ordered_at?: string; // ISO date string
  delivered_at?: string; // ISO date string
  returned_at?: string; // ISO date string
  exchanged_at?: string; // ISO date string
  gift_card_applied?: boolean;
  cancel_reason?: string; // For cancelled orders
  order_status?: string; // Alternative status field used in some orders
  exchange_items?: { [oldItemId: string]: string } | string[]; // For exchange tracking
  exchange_new_items?: string[]; // New items in exchange
  exchange_payment_method_id?: string; // Payment method for exchange price difference
  exchange_price_difference?: number; // Price difference in exchanges
}

export interface OrderItem {
  name: string;
  product_id: string;
  item_id: string;
  price: number;
  quantity?: number; // Some orders have quantity field
  options?: {
    [option_name: string]: string;
  };
}

export interface Product {
  name: string;
  product_id: string;
  variants: {
    [item_id: string]: ProductVariant;
  };
}

export interface ProductVariant {
  item_id: string;
  options: {
    [option_name: string]: string;
  };
  available: boolean;
  price: number;
}

export interface RetailData {
  users: { [user_id: string]: UserProfile };
  orders: { [order_id: string]: Order };
  products: { [product_id: string]: Product };
}

export interface ActionResult {
  success: boolean;
  data?: any;
  error?: string;
}

export interface RetailContext {
  current_user_id?: string;
  authenticated: boolean;
  data: RetailData;
}
