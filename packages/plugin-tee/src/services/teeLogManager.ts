import {
  type TEEMode,
  type TeeAgent,
  type TeeLog,
  type TeeLogDAO,
  type TeeLogQuery,
  type TeePageQuery,
  TeeType,
} from '@elizaos/core';
import elliptic from 'elliptic';
import { v4 } from 'uuid';
import { SgxAttestationProvider } from '../providers/remoteAttestationProvider';
import { PhalaRemoteAttestationProvider as TdxAttestationProvider } from '../providers/remoteAttestationProvider';

/**
 * Manage TeeLog related operations including agent registration, logging, and retrieval.
 */
export class TeeLogManager {
  private teeLogDAO: TeeLogDAO;
  private teeType: TeeType;
  private teeMode: TEEMode; // Only used for plugin-tee with TDX dstack

  // Map of agentId to its key pair
  // These keypairs only store in memory.
  // When the agent restarts, we will generate new keypair.
  private keyPairs: Map<string, elliptic.ec.KeyPair> = new Map();

  /**
   * Constructor for initializing TeeLog object.
   * * @param { TeeLogDAO } teeLogDAO - The data access object for TeeLog.
   * @param { TeeType } teeType - The type of Tee.
   * @param { TEEMode } teeMode - The mode of Tee.
   */
  constructor(teeLogDAO: TeeLogDAO, teeType: TeeType, teeMode: TEEMode) {
    this.teeLogDAO = teeLogDAO;
    this.teeType = teeType;
    this.teeMode = teeMode;
  }

  /**
   * Registers a new agent with the given agent ID and agent name.
   *
   * @param {string} agentId - The unique identifier for the agent.
   * @param {string} agentName - The name of the agent.
   * @returns {Promise<boolean>} A promise that resolves to true if the agent is successfully registered.
   * @throws {Error} If agentId is empty or null.
   */
  public async registerAgent(agentId: string, agentName: string): Promise<boolean> {
    if (!agentId) {
      throw new Error('Agent ID is required');
    }

    const keyPair = this.generateKeyPair();
    this.keyPairs.set(agentId, keyPair);

    const publicKey = keyPair.getPublic().encode('hex', true);
    const attestation = await this.generateAttestation(publicKey);

    const new_agent = {
      id: v4(),
      agentId,
      agentName: agentName || '',
      createdAt: new Date().getTime(),
      publicKey,
      attestation,
    };

    return this.teeLogDAO.addAgent(new_agent);
  }

  /**
   * Retrieves all agents from the database.
   * @returns {Promise<TeeAgent[]>} A promise that resolves to an array of TeeAgent objects.
   */
  public async getAllAgents(): Promise<TeeAgent[]> {
    return this.teeLogDAO.getAllAgents();
  }

  /**
   * Retrieve an agent from the database by its ID.
   * @param {string} agentId - The unique identifier of the agent.
   * @returns {Promise<TeeAgent | undefined>} The agent object if found, undefined otherwise.
   */
  public async getAgent(agentId: string): Promise<TeeAgent | undefined> {
    return this.teeLogDAO.getAgent(agentId);
  }

  /**
   * Logs an event with the specified information.
   *
   * @param {string} agentId - The ID of the agent performing the action.
   * @param {string} roomId - The room ID where the event occurred.
   * @param {string} entityId - The ID of the entity involved in the event.
   * @param {string} type - The type of event being logged.
   * @param {string} content - The content of the event being logged.
   * @returns {Promise<boolean>} A boolean indicating if the logging was successful.
   */
  public async log(
    agentId: string,
    roomId: string,
    entityId: string,
    type: string,
    content: string
  ): Promise<boolean> {
    const keyPair = this.keyPairs.get(agentId);
    if (!keyPair) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const timestamp = new Date().getTime();

    // Join the information into a single string
    const messageToSign = `${agentId}|${roomId}|${entityId}|${type}|${content}|${timestamp}`;

    // Sign the joined message
    const signature = `0x${keyPair.sign(messageToSign).toDER('hex')}`;

    return this.teeLogDAO.addLog({
      id: v4(),
      agentId,
      roomId,
      entityId,
      type,
      content,
      timestamp,
      signature,
    });
  }

  /**
   * Retrieves logs based on the provided query, page number, and page size.
   * @param {TeeLogQuery} query - The query object to filter logs.
   * @param {number} page - The page number of logs to retrieve.
   * @param {number} pageSize - The number of logs per page.
   * @returns {Promise<TeePageQuery<TeeLog[]>>} A promise that resolves to a page query of logs.
   */
  public async getLogs(
    query: TeeLogQuery,
    page: number,
    pageSize: number
  ): Promise<TeePageQuery<TeeLog[]>> {
    return this.teeLogDAO.getPagedLogs(query, page, pageSize);
  }

  /**
   * Generate a new key pair using the secp256k1 elliptic curve algorithm.
   *
   * @returns {elliptic.ec.KeyPair} The generated key pair.
   */
  public generateKeyPair(): elliptic.ec.KeyPair {
    const ec = new elliptic.ec('secp256k1');
    const key = ec.genKeyPair();
    return key;
  }

  /**
   * Generates an attestation for the given user report based on the TEE type.
   *
   * @param {string} userReport The user report to generate the attestation for.
   * @returns {Promise<string>} A promise that resolves with the generated attestation as a string.
   * @throws {Error} If the TEE type is invalid.
   */
  public async generateAttestation(userReport: string): Promise<string> {
    if (this.teeType === TeeType.SGX_GRAMINE) {
      const sgxAttestationProvider = new SgxAttestationProvider();
      const sgxAttestation = await sgxAttestationProvider.generateAttestation(userReport);
      return JSON.stringify(sgxAttestation);
    }
    if (this.teeType === TeeType.TDX_DSTACK) {
      const tdxAttestationProvider = new TdxAttestationProvider(this.teeMode);
      const tdxAttestation = await tdxAttestationProvider.generateAttestation(userReport);
      return JSON.stringify(tdxAttestation);
    }
    throw new Error('Invalid TEE type');
  }
}
