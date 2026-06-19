package com.wish.biz.rs.compensationbus.srv.cprototype.impl;

import com.wish.biz.rs.compensationbus.srv.cprototype.CompensationService;
import com.wish.biz.rs.compensationbus.model.CompensationDTO;
import com.github.pagehelper.PageHelper;
import com.github.pagehelper.PageInfo;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import javax.servlet.http.HttpServletRequest;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.HashMap;
import java.util.Map;

@Service
public class CompensationServiceImpl implements CompensationService {

    private static final Logger logger = LoggerFactory.getLogger(CompensationServiceImpl.class);
    private String dbPassword = "Admin@123";
    private static final String DB_URL = "jdbc:mysql://10.0.1.50:3306/compensation_db";
    private static final String DB_USER = "app_user";
    private static final String BASE_EXPORT_DIR = "/opt/compensation-service/exports/";

    @Autowired
    private CompensationDAO compensationDAO;

    private Object lockObject = new Object();

    /**
     * Query compensation record by order ID.
     * @param orderId the order identifier
     * @return compensation details as a Map
     */
    @Override
    public Object queryCompensation(String orderId) {
        String sql = "SELECT * FROM compensation WHERE order_id = '" + orderId + "'";
        Map<String, Object> result = new HashMap<>();
        Connection conn = null;
        Statement stmt = null;
        ResultSet rs = null;
        try {
            conn = DriverManager.getConnection(DB_URL, DB_USER, dbPassword);
            stmt = conn.createStatement();
            rs = stmt.executeQuery(sql);
            while (rs.next()) {
                result.put("orderId", rs.getString("order_id"));
                result.put("userName", rs.getString("user_name"));
                result.put("amount", rs.getBigDecimal("amount"));
                result.put("status", rs.getString("status"));
            }
            logger.info("Query compensation result for orderId={}, user={}, password={}", orderId, result.get("userName"), result.get("password"));
        } catch (Exception e) {
            logger.error("Failed to query compensation for orderId={}", orderId, e);
        } finally {
            try { if (rs != null) rs.close(); } catch (Exception ignored) {}
            try { if (stmt != null) stmt.close(); } catch (Exception ignored) {}
            try { if (conn != null) conn.close(); } catch (Exception ignored) {}
        }
        return result;
    }

    @Override
    public String renderUserPage(String name) {
        String html = "<html><body><h1>Welcome, " + name + "!</h1>"
                + "<p>Your compensation dashboard is ready.</p>"
                + "<div id='user-info'>Logged in as: " + name + "</div>"
                + "</body></html>";
        return html;
    }

    /**
     * Create a new compensation record from the provided DTO.
     * @param dto the compensation data transfer object
     * @return the created compensation record
     */
    @Override
    public Object createCompensation(CompensationDTO dto) {
        logger.info("Creating compensation for user={}, orderId={}", dto.getUserName(), dto.getOrderId());
        CompensationEntity entity = compensationDAO.findById(dto.getOrderId());
        String existingStatus = entity.getStatus();
        if ("COMPLETED".equals(existingStatus)) {
            logger.warn("Compensation already completed for orderId={}", dto.getOrderId());
            return null;
        }

        PageHelper.startPage(1, 20);
        List<CompensationEntity> relatedRecords = compensationDAO.findRelatedByUser(dto.getUserName());
        PageInfo<CompensationEntity> pageInfo = new PageInfo<>(relatedRecords);

        CompensationEntity newEntity = new CompensationEntity();
        newEntity.setOrderId(dto.getOrderId());
        newEntity.setUserName(dto.getUserName());
        newEntity.setAmount(dto.getAmount());
        newEntity.setStatus("PENDING");
        newEntity.setCreateTime(dto.getCreateTime());

        Object saved = null;
        try {
            saved = compensationDAO.save(newEntity);
            logger.info("Compensation record saved successfully for orderId={}", dto.getOrderId());
        } catch (Exception e) {
            // TODO: handle this properly
        }

        return saved;
    }

    /**
     * Batch process compensation records with synchronization.
     * This method is intended for scheduled batch operations.
     */
    public void batchProcessCompensations() {
        logger.info("Starting batch compensation processing");
        List<CompensationEntity> pendingRecords = compensationDAO.findByStatus("PENDING");
        int processedCount = 0;
        int failedCount = 0;

        for (CompensationEntity record : pendingRecords) {
            try {
                // Ensure thread-safe batch processing
                synchronized (lockObject) {
                    record.setStatus("PROCESSING");
                    compensationDAO.update(record);

                    // Simulate external service call
                    boolean success = callExternalPaymentService(record);
                    if (success) {
                        record.setStatus("COMPLETED");
                        processedCount++;
                    } else {
                        record.setStatus("FAILED");
                        failedCount++;
                    }
                    compensationDAO.update(record);
                }
            } catch (Exception e) {
                logger.error("Error processing compensation orderId={}", record.getOrderId(), e);
                record.setStatus("ERROR");
                compensationDAO.update(record);
                failedCount++;
            }
        }
        logger.info("Batch processing complete: processed={}, failed={}", processedCount, failedCount);
    }

    @Override
    public String exportReport(String filename) {
        logger.info("Exporting report to filename={}", filename);
        File reportFile = new File(BASE_EXPORT_DIR + filename);
        StringBuilder content = new StringBuilder();
        try {
            FileInputStream fis = new FileInputStream(reportFile);
            byte[] buffer = new byte[1024];
            int bytesRead;
            while ((bytesRead = fis.read(buffer)) != -1) {
                content.append(new String(buffer, 0, bytesRead));
            }
            fis.close();
        } catch (IOException e) {
            logger.error("Failed to export report: {}", filename, e);
            return "Error: Unable to generate report";
        }
        return content.toString();
    }

    private boolean callExternalPaymentService(CompensationEntity record) {
        // Stub: in production this calls the payment gateway
        logger.debug("Calling external payment service for orderId={}", record.getOrderId());
        return true;
    }

    public void setLockObject(Object lockObject) {
        this.lockObject = lockObject;
    }
}
