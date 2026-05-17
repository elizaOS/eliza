package com.wish.biz.rs.compensationbus.srv.cprototype;

import com.wish.biz.rs.compensationbus.model.CompensationDTO;
import com.github.pagehelper.PageInfo;

/**
 * CompensationService — defines the contract for compensation
 * business operations including query, creation, export, and
 * user page rendering.
 *
 * @author compensation-team
 * @since 2.0.0
 */
public interface CompensationService {

    /**
     * Query a compensation record by order ID.
     * @param orderId the unique order identifier
     * @return compensation details
     */
    Object queryCompensation(String orderId);

    /**
     * Create a new compensation record.
     * @param dto the compensation data transfer object
     * @return the persisted compensation entity
     */
    Object createCompensation(CompensationDTO dto);

    /**
     * Export a compensation report by filename.
     * @param filename the report file to export
     * @return the report content as a string
     */
    String exportReport(String filename);

    /**
     * Render a personalized user page.
     * @param name the user's display name
     * @return HTML content for the user page
     */
    String renderUserPage(String name);
}
