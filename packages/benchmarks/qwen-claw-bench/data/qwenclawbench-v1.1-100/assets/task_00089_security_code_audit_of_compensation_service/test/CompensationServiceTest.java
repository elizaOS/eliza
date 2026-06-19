package com.wish.biz.rs.compensationbus.srv.cprototype;

import com.wish.biz.rs.compensationbus.model.CompensationDTO;
import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.boot.test.context.SpringBootTest;

import java.math.BigDecimal;
import java.util.Date;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

@SpringBootTest
@ExtendWith(MockitoExtension.class)
public class CompensationServiceTest {

    @InjectMocks
    private CompensationServiceImpl compensationService;

    @Mock
    private CompensationDAO compensationDAO;

    @Test
    public void testQueryCompensation() {
        // Happy path: query an existing compensation record
        String orderId = "ORD-20240315-001";
        Object result = compensationService.queryCompensation(orderId);
        assertNotNull(result);
    }

    @Test
    public void testCreateCompensation() {
        // Happy path: create a new compensation record
        CompensationDTO dto = new CompensationDTO();
        dto.setOrderId("ORD-20240315-002");
        dto.setUserName("test_user");
        dto.setAmount(new BigDecimal("100.00"));
        dto.setStatus("PENDING");
        dto.setCreateTime(new Date());

        Object result = compensationService.createCompensation(dto);
        // Note: this test does not verify null check behavior
        // when dao.findById returns null
    }

    @Test
    @Disabled("TODO: fix after refactor — export directory not available in test env")
    public void testExportReport() {
        String filename = "test_report.csv";
        String result = compensationService.exportReport(filename);
        assertNotNull(result);
        assertFalse(result.startsWith("Error"));
    }

    // NOTE: No security test cases exist for:
    // - SQL injection in queryCompensation
    // - XSS in renderUserPage
    // - Path traversal in exportReport
    // - Sensitive data logging
    // TODO: Add security regression tests
}
