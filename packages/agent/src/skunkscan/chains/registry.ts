import { ChainIdentifier } from "../types";

import {
  BlockchainConnector,
  BlockchainConnectorRegistry,
} from "./types";

import { solanaBlockchainConnector } from "./solana";
import { ethereumBlockchainConnector } from "./ethereum";

export class DefaultBlockchainConnectorRegistry
  implements BlockchainConnectorRegistry
{
  private readonly connectors = new Map<
    ChainIdentifier,
    BlockchainConnector
  >();

  register(connector: BlockchainConnector): void {
    this.connectors.set(
      connector.descriptor.chainId,
      connector,
    );
  }

  unregister(chainId: ChainIdentifier): void {
    this.connectors.delete(chainId);
  }

  get(
    chainId: ChainIdentifier,
  ): BlockchainConnector | undefined {
    return this.connectors.get(chainId);
  }

  has(chainId: ChainIdentifier): boolean {
    return this.connectors.has(chainId);
  }

  list(): BlockchainConnector[] {
    return Array.from(this.connectors.values());
  }

  listEnabled(): BlockchainConnector[] {
    return this.list().filter(
      (connector) => connector.network.isEnabled,
    );
  }
}

export const blockchainConnectorRegistry =
  new DefaultBlockchainConnectorRegistry();

blockchainConnectorRegistry.register(
  solanaBlockchainConnector,
);

blockchainConnectorRegistry.register(
  ethereumBlockchainConnector,
);

export function getBlockchainConnector(
  chainId: ChainIdentifier,
): BlockchainConnector | undefined {
  return blockchainConnectorRegistry.get(chainId);
}

export function requireBlockchainConnector(
  chainId: ChainIdentifier,
): BlockchainConnector {
  const connector =
    blockchainConnectorRegistry.get(chainId);

  if (!connector) {
    throw new Error(
      `No blockchain connector is registered for chain "${chainId}"`,
    );
  }

  return connector;
}

export function listBlockchainConnectors(): BlockchainConnector[] {
  return blockchainConnectorRegistry.list();
}

export function listEnabledBlockchainConnectors(): BlockchainConnector[] {
  return blockchainConnectorRegistry.listEnabled();
}
