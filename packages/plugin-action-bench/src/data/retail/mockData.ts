import { RetailData } from '../../types/retail';
import usersData from './users.json';
import ordersData from './orders.json';
import productsData from './products.json';

export const mockRetailData: RetailData = {
  users: usersData as any,
  orders: ordersData as any,
  products: productsData as any,
};

// Helper function to get a copy of the retail data
export function getRetailData(): RetailData {
  // Return a deep copy to prevent mutations
  return JSON.parse(JSON.stringify(mockRetailData));
}
