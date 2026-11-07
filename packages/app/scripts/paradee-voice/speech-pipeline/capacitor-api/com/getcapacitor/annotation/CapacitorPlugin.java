package com.getcapacitor.annotation;
import java.lang.annotation.*;
@Retention(RetentionPolicy.RUNTIME) @Target(ElementType.TYPE) public @interface CapacitorPlugin { String name() default ""; }
