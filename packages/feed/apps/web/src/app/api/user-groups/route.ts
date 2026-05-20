/**
 * Legacy user-groups API alias.
 *
 * The canonical route is `/api/groups`, but older clients and integration
 * coverage still call `/api/user-groups` for the authenticated group listing.
 */

export { GET } from '../groups/route';
