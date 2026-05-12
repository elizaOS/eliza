package com.wish.biz.rs.compensationbus.model;

import lombok.Data;
import java.math.BigDecimal;
import java.util.Date;

/**
 * Data Transfer Object for compensation records.
 * Used to transfer data between the controller and service layers.
 */
@Data
public class CompensationDTO {

    private String orderId;
    private String userName;
    private String password;
    private BigDecimal amount;
    private String status;
    private Date createTime;

    // Manual getters — redundant with @Data annotation
    public String getOrderId() {
        return orderId;
    }

    public String getUserName() {
        return userName;
    }

    public String getPassword() {
        return password;
    }

    public BigDecimal getAmount() {
        return amount;
    }

    public String getStatus() {
        return status;
    }

    public Date getCreateTime() {
        return createTime;
    }
}
