const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePlanInput, createPlanMessages } = require('../services/nutrition-plan');

const validInput = {
    age: 30,
    weightKg: 70,
    heightCm: 175,
    eatingPattern: 'vegetarian',
    activityLevel: 'moderate',
    goal: 'training',
    foodsToAvoid: 'peanuts',
    healthyAdultConfirmed: true,
    externalProcessingConfirmed: true
};

test('validates and normalizes a session-only meal-plan profile', () => {
    assert.deepEqual(validatePlanInput(validInput), {
        age: 30,
        weightKg: 70,
        heightCm: 175,
        eatingPattern: 'vegetarian',
        activityLevel: 'moderate',
        goal: 'training',
        foodsToAvoid: 'peanuts'
    });
});

test('rejects minors and users who have not confirmed the general-plan safety conditions', () => {
    assert.throws(() => validatePlanInput({ ...validInput, age: 18 }), /only available for adults/);
    assert.throws(() => validatePlanInput({ ...validInput, healthyAdultConfirmed: false }), /Confirm that a general meal draft/);
});

test('rejects oversized food exclusions and missing AI-processing consent', () => {
    assert.throws(() => validatePlanInput({ ...validInput, foodsToAvoid: 'x'.repeat(201) }), /200 characters or fewer/);
    assert.throws(() => validatePlanInput({ ...validInput, externalProcessingConfirmed: false }), /send these details to the AI provider/);
});

test('constrains generated plans to meal ideas without invented nutrient prescriptions', () => {
    const messages = createPlanMessages(validatePlanInput(validInput));
    assert.match(messages[0].content, /Do not calculate or state calorie targets, protein or macro totals/);
    assert.match(messages[0].content, /avoid every listed food exclusion/);
    assert.match(messages[1].content, /"weightKg":70/);
});
