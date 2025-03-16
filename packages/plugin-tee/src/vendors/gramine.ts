import { sgxAttestationProvider } from '../providers/remoteAttestationProvider';
import type { TeeVendor } from './types';
import { TeeVendorNames } from './types';

/**
 * Vendor class for SGX Gramine TEE.
 * @implements {TeeVendor}
 */

export class GramineVendor implements TeeVendor {
  type = TeeVendorNames.SGX_GRAMINE;

  /**
   * Returns an array of actions.
   * @returns {Array} An empty array of actions.
   */
  getActions() {
    return [];
  }

  /**
   * Retrieve the list of providers available.
   *
   * @returns {Array} An array containing the available providers.
   */
  getProviders() {
    return [sgxAttestationProvider];
  }

  /**
   * Function to get the name of the plugin.
   * @returns {string} The name of the plugin.
   */
  getName() {
    return 'sgx-gramine-plugin';
  }

  /**
   * Returns the description of the SGX Gramine TEE to Host Eliza Agents.
   */
  getDescription() {
    return 'SGX Gramine TEE to Host Eliza Agents';
  }
}
