/*
 * Copyright (C) 2023 The Android Open Source Project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

package com.android.systemui.keyguard.ui.view.layout.sections

import android.content.Context
import android.view.ViewGroup
import androidx.constraintlayout.widget.ConstraintLayout
import androidx.constraintlayout.widget.ConstraintSet
import com.android.systemui.keyguard.shared.model.KeyguardSection
import com.android.systemui.keyguard.ui.binder.KeyguardIndicationAreaBinder
import com.android.systemui.keyguard.ui.view.KeyguardIndicationArea
import com.android.systemui.keyguard.ui.viewmodel.KeyguardIndicationAreaViewModel
import com.android.systemui.res.R
import com.android.systemui.shade.ShadeDisplayAware
import com.android.systemui.statusbar.KeyguardIndicationController
import javax.inject.Inject
import kotlinx.coroutines.DisposableHandle

class DefaultIndicationAreaSection
@Inject
constructor(
    @ShadeDisplayAware private val context: Context,
    private val keyguardIndicationAreaViewModel: KeyguardIndicationAreaViewModel,
    private val indicationController: KeyguardIndicationController,
) : KeyguardSection() {
    private val indicationAreaViewId = R.id.keyguard_indication_area
    private var indicationAreaHandle: DisposableHandle? = null

    override fun addViews(constraintLayout: ConstraintLayout) {
        val view = KeyguardIndicationArea(context, null)
        constraintLayout.addView(view)
    }

    override fun bindData(constraintLayout: ConstraintLayout) {
        indicationAreaHandle =
            KeyguardIndicationAreaBinder.bind(
                constraintLayout.requireViewById(R.id.keyguard_indication_area),
                keyguardIndicationAreaViewModel,
                indicationController,
            )
    }

    override fun applyConstraints(constraintSet: ConstraintSet) {
        constraintSet.apply {
            constrainWidth(indicationAreaViewId, ViewGroup.LayoutParams.MATCH_PARENT)
            constrainHeight(indicationAreaViewId, ViewGroup.LayoutParams.WRAP_CONTENT)
            connect(
                indicationAreaViewId,
                ConstraintSet.BOTTOM,
                ConstraintSet.PARENT_ID,
                ConstraintSet.BOTTOM,
                context.resources.getDimensionPixelSize(R.dimen.keyguard_indication_margin_bottom)
            )
            connect(
                indicationAreaViewId,
                ConstraintSet.START,
                ConstraintSet.PARENT_ID,
                ConstraintSet.START
            )
            connect(
                indicationAreaViewId,
                ConstraintSet.END,
                ConstraintSet.PARENT_ID,
                ConstraintSet.END
            )
        }
    }

    override fun removeViews(constraintLayout: ConstraintLayout) {
        indicationAreaHandle?.dispose()
        constraintLayout.removeView(indicationAreaViewId)
    }
}
