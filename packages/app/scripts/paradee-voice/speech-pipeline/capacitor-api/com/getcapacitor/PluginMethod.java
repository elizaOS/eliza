package com.getcapacitor;
import java.lang.annotation.*;
@Retention(RetentionPolicy.RUNTIME) public @interface PluginMethod { String returnType() default "promise"; }
